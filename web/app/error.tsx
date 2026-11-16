// Any other error while a page renders. "Försök igen" retries.
import type { ErrorProps } from "northstack";

export default function ErrorPage({ error, retry }: ErrorProps) {
  return (
    <div className="page-state glass">
      <h2>Något gick fel</h2>
      <p>{error.message}</p>
      <button onClick={retry}>Försök igen</button>
    </div>
  );
}
