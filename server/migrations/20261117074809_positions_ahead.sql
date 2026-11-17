-- The track ahead of a moving train (~2 km, straight on at junctions): [[lat, lon], ...].
ALTER TABLE positions ADD COLUMN ahead JSON;
