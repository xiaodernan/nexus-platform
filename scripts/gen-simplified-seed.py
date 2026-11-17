"""NEXUS D1278 — fold the chapter fixture arms of the demo plane.

`apps/web/src/lib/mock/seed.ts` carries the 105 HK chapters (DEMO_GUIDES) and the
storefront-collections (DEMO_COLLECTIONS) written in Traditional Chinese. A `zh-CN`
visitor deserves to read the same fold the rest of the product was given in D1276.

The fold is the same one D1276 used: opencc `hk2s` then `t2s`. Slugs, ids, URLs,
dates and structure are ASCII and pass through untouched; only CJK glyphs move.

Usage:
    python scripts/gen-simplified-seed.py            # write the arms in place
    python scripts/gen-simplified-seed.py --check    # exit 1 if stale, print diff summary

The generated file must be committed. CI's lockstep gate (`scripts/check_simplified_seed.mjs`,
to be wired into verify_all) re-derives the fold and refuses drift.
"""
import io
import os
import site
import sys

_user_site = getattr(site, 'USER_SITE', None)
if _user_site and _user_site not in sys.path:
    sys.path.append(_user_site)

try:
    import opencc  # type: ignore
except ModuleNotFoundError:
    print('opencc-python-reimplemented is not installed.', file=sys.stderr)
    print('  pip install --user opencc-python-reimplemented', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'mock', 'seed.ts')
OUT = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'mock', 'seed-cn.ts')

HK2S = opencc.OpenCC('hk2s')
T2S = opencc.OpenCC('t2s')


# The fold cannot decide rare/proper Cantonese glyphs; record the same corrections the
# dict generator uses so neither arm produces a glyph the reader cannot read.
POST_FOLD_REPLACEMENTS = {
    '𠮶': '个',   # the Cantonese demonstrative deictic; the Simplified arm uses the plain 个 glyph
    '𫚭': '鱲',   # 赤鱲角 (Chek Lap Kok, Hong Kong Intl Airport) keeps 鱲 in Simplified Chinese
    '𩠌': '餸',   # Hong Kong kitchen vocabulary (sung3) — a dish; keep the authentic form
}


def fold(text: str) -> str:
    converted = T2S.convert(HK2S.convert(text))
    for src, dst in POST_FOLD_REPLACEMENTS.items():
        converted = converted.replace(src, dst)
    return converted


def slice_const(src: str, start_needle: str) -> str:
    i = src.find(start_needle)
    if i == -1:
        raise SystemExit(f'block not found: {start_needle!r}')
    end = src.find('\n];', i)
    if end == -1:
        raise SystemExit(f'block end not found after: {start_needle!r}')
    return src[i:end + 3]


def render(src: str) -> str:
    guides = slice_const(src, 'export const DEMO_GUIDES: Guide[] = [')
    collections = slice_const(src, 'export const DEMO_COLLECTIONS: Collection[] = [')

    guides_cn = fold(guides).replace('DEMO_GUIDES', 'DEMO_GUIDES_CN')
    collections_cn = fold(collections).replace('DEMO_COLLECTIONS', 'DEMO_COLLECTIONS_CN')

    return (
        '/** GENERATED Simplified-Chinese twin of DEMO_GUIDES + DEMO_COLLECTIONS from ./seed.ts —'
        ' fold via opencc-python-reimplemented (hk2s+t2s). DO NOT EDIT BY HAND. */\n'
        "import type { Collection, Guide } from '../types';\n\n"
        + collections_cn
        + '\n\n'
        + guides_cn
        + '\n'
    )


def main() -> int:
    check_only = '--check' in sys.argv[1:]
    with io.open(SRC, encoding='utf-8') as fh:
        rendered = render(fh.read())
    current = None
    if os.path.exists(OUT):
        with io.open(OUT, encoding='utf-8') as fh:
            current = fh.read().replace('\r\n', '\n')
    if current == rendered.replace('\r\n', '\n'):
        print('in lockstep: apps/web/src/lib/mock/seed-cn.ts')
        return 0
    if check_only:
        print('STALE — regenerate with `python scripts/gen-simplified-seed.py`', file=sys.stderr)
        return 1
    with io.open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(rendered)
    print('regenerated: apps/web/src/lib/mock/seed-cn.ts')
    return 0


if __name__ == '__main__':
    sys.exit(main())
