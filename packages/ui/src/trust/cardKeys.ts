/**
 * One React key per member of a card list.
 *
 * WHY A LIST MAY HOLD THE SAME CARD TWICE. The platform resolves a guide's items in the author's order
 * and keeps every reference — it resolves each item and adds the card it resolved, so a guide that cites
 * one shop in two places yields that shop's card twice. The seeded Sha Tin date-night route does
 * exactly that: its membership is `datey[:9] + datey[:1]`, so the route holds ten references over nine
 * shops and its first member (`umber-ridge-0029`) is cited at position 1 and again at position 10
 * (`data/seed/generate.py`, `build_collections`). The wire is right to keep both — the row's
 * `item_count` says ten, and a `cards` array one shorter than the items it came from reads as a lost
 * item.
 *
 * THE RULE. A React key names a list member, and two members of one list may not share one. A card's
 * `id` is its IDENTITY, and an identity is not unique inside a list that holds that card twice — so the
 * key names the OCCURRENCE: the first appearance of an id keeps the bare id, and a repeat is suffixed
 * with the number of earlier appearances of that same id.
 *
 * The suffix counts appearances of the same id rather than positions in the list, so a list of distinct
 * cards keys exactly as it did before this helper existed (no remount, no churn) and a card keeps its key
 * when an unrelated card joins the list.
 */
export function cardKeys(cards: readonly { id: string }[]): string[] {
  const seen = new Map<string, number>();
  return cards.map((card) => {
    const earlier = seen.get(card.id) ?? 0;
    seen.set(card.id, earlier + 1);
    return earlier === 0 ? card.id : `${card.id}#${earlier}`;
  });
}
