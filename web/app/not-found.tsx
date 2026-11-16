// Unknown URLs and NOT_FOUND errors from the API.
export default function NotFound() {
  return (
    <div className="page-state glass">
      <title>Hittades inte · Tuff</title>
      <h2>Hittades inte</h2>
      <p>Sidan finns inte.</p>
      <a href="/">Till kartan</a>
    </div>
  );
}
