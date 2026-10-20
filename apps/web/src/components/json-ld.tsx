/**
 * Structured data (§29) rendered from the same payload the page shows.
 *
 * `JSON.stringify` output is placed in a `<script>` verbatim, so the only safety question is what
 * gets into the object: every value here comes from the data plane, and a number appears only when
 * the fact behind it resolves on the server — an unverified rating is omitted, never guessed.
 */

export function JsonLd({ value }: { value: Record<string, unknown> }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(value) }} />;
}
