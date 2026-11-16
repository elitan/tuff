//! Trafikverket's open API (https://data.trafikverket.se): stations, timetable
//! announcements and live train positions. Queries are XML, answers JSON.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, anyhow, bail};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::types::{BoardRow, TrainInfo};

const API_URL: &str = "https://api.trafikinfo.trafikverket.se/v2/data.json";

#[derive(Clone)]
pub struct Trafikverket {
    http: reqwest::Client,
    key: Option<String>,
}

/// A station as Trafikverket describes it.
pub struct RawStation {
    pub sig: String,
    pub name: String,
    pub short_name: String,
    pub advertised: bool,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
}

/// One GPS fix from the position feed.
#[derive(Debug, Clone, PartialEq)]
pub struct RawFix {
    pub train: String,
    pub lat: f64,
    pub lon: f64,
    pub bearing: Option<f64>,
    pub speed: Option<f64>,
    pub ts: i64,
}

impl Trafikverket {
    pub fn new(http: reqwest::Client, key: Option<String>) -> Self {
        Self { http, key }
    }

    async fn query(&self, xml: &str) -> anyhow::Result<Value> {
        let key = self
            .key
            .as_deref()
            .ok_or_else(|| anyhow!("TRAFIKVERKET_API_KEY is not set (see .env.example)"))?;
        let body = format!(
            r#"<REQUEST><LOGIN authenticationkey="{}"/>{xml}</REQUEST>"#,
            xml_attr(key)
        );
        let res = self
            .http
            .post(API_URL)
            .header("Content-Type", "text/xml")
            .body(body)
            .timeout(Duration::from_secs(60))
            .send()
            .await?;
        let status = res.status();
        if !status.is_success() {
            let text = res.text().await.unwrap_or_default();
            bail!(
                "Trafikverket HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            );
        }
        let mut json: Value = res.json().await?;
        let first = json["RESPONSE"]["RESULT"][0].take();
        if let Some(err) = first.get("ERROR") {
            bail!("Trafikverket: {err}");
        }
        Ok(first)
    }

    /// Every station (passenger or not: timetables name them all).
    pub async fn stations(&self) -> anyhow::Result<Vec<RawStation>> {
        let res = self
            .query(
                r#"<QUERY objecttype="TrainStation" namespace="rail.infrastructure" schemaversion="1.5">
                <INCLUDE>LocationSignature</INCLUDE><INCLUDE>AdvertisedShortLocationName</INCLUDE>
                <INCLUDE>AdvertisedLocationName</INCLUDE><INCLUDE>Advertised</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE></QUERY>"#,
            )
            .await?;
        let list = res["TrainStation"].as_array().context("TrainStation")?;
        Ok(list
            .iter()
            .filter_map(|s| {
                let sig = s["LocationSignature"].as_str()?.to_string();
                let long = s["AdvertisedLocationName"].as_str();
                let short = s["AdvertisedShortLocationName"].as_str();
                let p = point(s["Geometry"]["WGS84"].as_str());
                Some(RawStation {
                    name: long.or(short).unwrap_or(&sig).to_string(),
                    short_name: short.or(long).unwrap_or(&sig).to_string(),
                    advertised: s["Advertised"].as_bool().unwrap_or(false),
                    lat: p.map(|p| p.0),
                    lon: p.map(|p| p.1),
                    sig,
                })
            })
            .collect())
    }

    /// Advertised trains with a stop between 2 h ago and 1 h from now, by train number.
    /// `names` maps location signatures to short names.
    pub async fn trains(&self, names: &HashMap<String, String>) -> anyhow::Result<Vec<TrainInfo>> {
        let res = self
            .query(
                r#"<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" limit="200000">
                <FILTER><EQ name="Advertised" value="true"/>
                  <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.02:00:00)"/>
                  <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.01:00:00)"/></FILTER>
                <INCLUDE>AdvertisedTrainIdent</INCLUDE><INCLUDE>ToLocation</INCLUDE><INCLUDE>FromLocation</INCLUDE>
                <INCLUDE>InformationOwner</INCLUDE><INCLUDE>ProductInformation</INCLUDE></QUERY>"#,
            )
            .await?;
        let name = |l: &Value| match l[0]["LocationName"].as_str() {
            Some(sig) => names.get(sig).cloned().unwrap_or_else(|| sig.to_string()),
            None => "?".to_string(),
        };
        let mut seen = HashMap::new();
        for a in res["TrainAnnouncement"]
            .as_array()
            .context("TrainAnnouncement")?
        {
            let Some(number) = a["AdvertisedTrainIdent"].as_str() else {
                continue;
            };
            seen.entry(number.to_string()).or_insert_with(|| {
                let owner = a["InformationOwner"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                TrainInfo {
                    number: number.to_string(),
                    from: name(&a["FromLocation"]),
                    to: name(&a["ToLocation"]),
                    product: a["ProductInformation"][0]["Description"]
                        .as_str()
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            if owner.is_empty() {
                                "Tåg".into()
                            } else {
                                owner.clone()
                            }
                        }),
                    owner,
                }
            });
        }
        Ok(seen.into_values().collect())
    }

    /// Departures and arrivals at a station: 30 min back to 6 h ahead.
    pub async fn board(
        &self,
        sig: &str,
        names: &HashMap<String, String>,
    ) -> anyhow::Result<(Vec<BoardRow>, Vec<BoardRow>)> {
        let xml = format!(
            r#"<QUERY objecttype="TrainAnnouncement" schemaversion="1.9" orderby="AdvertisedTimeAtLocation" limit="400">
            <FILTER><EQ name="LocationSignature" value="{}"/><EQ name="Advertised" value="true"/>
              <GT name="AdvertisedTimeAtLocation" value="$dateadd(-0.00:30:00)"/>
              <LT name="AdvertisedTimeAtLocation" value="$dateadd(0.06:00:00)"/></FILTER>
            <INCLUDE>ActivityId</INCLUDE><INCLUDE>ActivityType</INCLUDE><INCLUDE>AdvertisedTrainIdent</INCLUDE>
            <INCLUDE>AdvertisedTimeAtLocation</INCLUDE><INCLUDE>EstimatedTimeAtLocation</INCLUDE><INCLUDE>TimeAtLocation</INCLUDE>
            <INCLUDE>TrackAtLocation</INCLUDE><INCLUDE>Canceled</INCLUDE><INCLUDE>Deviation</INCLUDE>
            <INCLUDE>ToLocation</INCLUDE><INCLUDE>FromLocation</INCLUDE><INCLUDE>ViaToLocation</INCLUDE><INCLUDE>ViaFromLocation</INCLUDE>
            <INCLUDE>ProductInformation</INCLUDE><INCLUDE>InformationOwner</INCLUDE><INCLUDE>TypeOfTraffic</INCLUDE></QUERY>"#,
            xml_attr(sig)
        );
        let res = self.query(&xml).await?;
        let nm = |s: &str| names.get(s).cloned().unwrap_or_else(|| s.to_string());
        let ordered = |l: &Value| {
            let mut v: Vec<(i64, String)> = l
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| {
                    Some((
                        x["Order"].as_i64().unwrap_or(0),
                        nm(x["LocationName"].as_str()?),
                    ))
                })
                .collect();
            v.sort_by_key(|x| x.0);
            v.into_iter().map(|x| x.1).collect::<Vec<_>>()
        };
        let now = Utc::now().timestamp_millis();
        let recent = now - 3 * 60_000; // keep trains that left in the last few minutes, greyed out
        let (mut departures, mut arrivals) = (Vec::new(), Vec::new());
        for a in res["TrainAnnouncement"]
            .as_array()
            .context("TrainAnnouncement")?
        {
            let dep = a["ActivityType"].as_str() == Some("Avgang");
            let time = a["AdvertisedTimeAtLocation"].as_str().unwrap_or_default();
            let estimated = a["EstimatedTimeAtLocation"].as_str();
            let actual = a["TimeAtLocation"].as_str();
            if actual.and_then(millis).is_some_and(|t| t < recent) {
                continue;
            }
            // no report at all long after its time (typically replacement buses): it's gone
            if actual.is_none()
                && millis(estimated.unwrap_or(time)).is_some_and(|t| t < now - 10 * 60_000)
            {
                continue;
            }
            let (place, via) = if dep {
                (ordered(&a["ToLocation"]), ordered(&a["ViaToLocation"]))
            } else {
                (ordered(&a["FromLocation"]), ordered(&a["ViaFromLocation"]))
            };
            let row = BoardRow {
                id: a["ActivityId"].as_str().unwrap_or_default().to_string(),
                train: a["AdvertisedTrainIdent"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                product: a["ProductInformation"][0]["Description"]
                    .as_str()
                    .or(a["InformationOwner"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                time: time.to_string(),
                estimated: estimated.map(str::to_string),
                actual: actual.map(str::to_string),
                track: a["TrackAtLocation"]
                    .as_str()
                    .filter(|t| *t != "x")
                    .map(str::to_string),
                canceled: a["Canceled"].as_bool().unwrap_or(false),
                place: if place.is_empty() {
                    "?".into()
                } else {
                    place.join(", ")
                },
                via: via.into_iter().take(3).collect(),
                notes: a["Deviation"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|d| d["Description"].as_str().map(str::to_string))
                    .collect(),
                bus: a["TypeOfTraffic"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|t| {
                        t["Description"]
                            .as_str()
                            .is_some_and(|d| d.to_lowercase().contains("buss"))
                    }),
            };
            if dep {
                departures.push(row)
            } else {
                arrivals.push(row)
            }
        }
        departures.truncate(60);
        arrivals.truncate(60);
        Ok((departures, arrivals))
    }

    /// Every train's fixes since `since`, plus the URL of the live stream that follows.
    pub async fn position_stream(
        &self,
        since: DateTime<Utc>,
    ) -> anyhow::Result<(Vec<RawFix>, String)> {
        // ($dateadd isn't allowed together with sseurl, so use an absolute time)
        let xml = format!(
            r#"<QUERY objecttype="TrainPosition" namespace="järnväg.trafikinfo" schemaversion="1.1" sseurl="true">
            <FILTER><GT name="TimeStamp" value="{}"/></FILTER></QUERY>"#,
            since.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
        let res = self.query(&xml).await?;
        let url = res["INFO"]["SSEURL"]
            .as_str()
            .context("no SSEURL")?
            .to_string();
        Ok((fixes(&res), url))
    }

    /// Open the live position stream (server-sent events).
    pub async fn open_stream(&self, url: &str) -> anyhow::Result<reqwest::Response> {
        let res = self
            .http
            .get(url)
            .header("Accept", "text/event-stream")
            .send()
            .await?;
        if !res.status().is_success() {
            bail!("position stream HTTP {}", res.status());
        }
        Ok(res)
    }
}

/// Fixes in one query result or stream event (`{ "TrainPosition": [...] }`).
pub fn fixes(result: &Value) -> Vec<RawFix> {
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Raw {
        train: Option<RawTrain>,
        position: Option<RawPoint>,
        bearing: Option<f64>,
        speed: Option<f64>,
        time_stamp: Option<String>,
        #[serde(default)]
        deleted: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct RawTrain {
        advertised_train_number: Option<String>,
    }
    #[derive(Deserialize)]
    struct RawPoint {
        #[serde(rename = "WGS84")]
        wgs84: Option<String>,
    }
    result["TrainPosition"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let r: Raw = serde_json::from_value(v.clone()).ok()?;
            if r.deleted {
                return None;
            }
            let (lat, lon) = point(r.position?.wgs84.as_deref())?;
            Some(RawFix {
                train: r.train?.advertised_train_number?,
                lat,
                lon,
                bearing: r.bearing,
                speed: r.speed,
                ts: millis(r.time_stamp.as_deref()?)?,
            })
        })
        .collect()
}

/// Stream events: `data:` lines, blocks separated by a blank line (upstream uses CRLF).
#[derive(Default)]
pub struct SseParser {
    buf: String,
}

impl SseParser {
    /// Feed a chunk; returns the data of every complete event.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf
            .push_str(&chunk.replace("\r\n", "\n").replace('\r', "\n"));
        let mut out = Vec::new();
        while let Some(i) = self.buf.find("\n\n") {
            let block: String = self.buf.drain(..i + 2).collect();
            let data: String = block
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .collect::<Vec<_>>()
                .join("");
            if !data.is_empty() {
                out.push(data);
            }
        }
        out
    }
}

/// "POINT (18.05 59.33)" -> (lat, lon)
fn point(wkt: Option<&str>) -> Option<(f64, f64)> {
    let inner = wkt?.split_once('(')?.1.split_once(')')?.0;
    let mut it = inner.split_whitespace().map(|v| v.parse::<f64>());
    let (lon, lat) = (it.next()?.ok()?, it.next()?.ok()?);
    Some((lat, lon))
}

fn millis(iso: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|t| t.timestamp_millis())
}

/// Escape a value for an XML attribute.
fn xml_attr(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_points_and_fixes() {
        assert_eq!(
            point(Some("POINT (18.0575 59.3303)")),
            Some((59.3303, 18.0575))
        );
        assert_eq!(point(Some("nonsense")), None);
        let v = serde_json::json!({ "TrainPosition": [
            { "Train": { "AdvertisedTrainNumber": "523" }, "Position": { "WGS84": "POINT (18.05 59.33)" },
              "Bearing": 90, "Speed": 120, "TimeStamp": "2026-11-16T10:00:00.000+01:00" },
            { "Train": { "AdvertisedTrainNumber": "9" }, "Position": { "WGS84": "POINT (18 59)" },
              "TimeStamp": "2026-11-16T10:00:00+01:00", "Deleted": true },
        ]});
        let f = fixes(&v);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].train, "523");
        assert_eq!(
            (f[0].lat, f[0].lon, f[0].speed),
            (59.33, 18.05, Some(120.0))
        );
        assert_eq!(f[0].ts, 1_794_819_600_000);
    }

    #[test]
    fn splits_sse_events() {
        let mut p = SseParser::default();
        assert!(p.push("data: {\"a\":").is_empty());
        let out = p.push("1}\r\n\r\n: comment\r\n\r\ndata: x\r\n");
        assert_eq!(out, vec![" {\"a\":1}".to_string()]);
        assert_eq!(p.push("\r\n"), vec![" x".to_string()]);
    }

    #[test]
    fn escapes_attributes() {
        assert_eq!(xml_attr(r#"a"b<c>&"#), "a&quot;b&lt;c&gt;&amp;");
    }
}
