import type { ReactNode } from 'react';

/**
 * A console table (§23/§68). Deliberately dumb: it renders the header and the rows it is given, and
 * when there are none it renders the caller's `empty` node instead of an empty grid. It never
 * fabricates a row, and it never renders a cell the caller did not supply.
 *
 * `caption` is required because an unlabelled operator table is a table a screen reader cannot
 * announce; the pages pass the section title.
 */
export function ConsoleTable({
  caption,
  head,
  rows,
  empty,
  className,
}: {
  caption: string;
  head: string[];
  rows: ReactNode[][];
  empty?: ReactNode;
  className?: string;
}) {
  if (rows.length === 0) {
    return <div className={className}>{empty ?? null}</div>;
  }
  return (
    <div className={`overflow-x-auto rounded-lg border border-line bg-surface ${className ?? ''}`}>
      <table className="w-full min-w-[44rem] border-collapse text-left text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            {head.map((label, index) => (
              <th
                key={`${label}-${index}`}
                scope="col"
                className="px-3 py-2 text-2xs font-medium uppercase tracking-wide text-ink-faint"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2.5 text-ink-strong">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
