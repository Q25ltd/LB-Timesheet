/**
 * One sentence on its own, between the explanation of the day and the
 * driver's side of it: the product's stance, set as type rather than boxed.
 */
export function Statement() {
  return (
    <section className="statement" aria-labelledby="statement-title">
      <div className="container">
        <h2 id="statement-title" className="statement__text">
          Built for the working day — <span className="statement__accent">not for adding more admin.</span>
        </h2>
      </div>
    </section>
  );
}
