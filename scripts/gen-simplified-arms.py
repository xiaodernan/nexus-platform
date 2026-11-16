"""NEXUS D1276 — regenerate the Simplified-Chinese arms of the web product.

The two `zh-CN` artifacts in `apps/web/src/lib/i18n/` are DERIVED from the canonical
Hong Kong arms (`zhHK` in dict.ts, `zhLabels` in trust-labels.ts). They are never
hand-edited: if you change Traditional copy, re-run this generator to re-fold.

Requirements: Python 3 with `opencc-python-reimplemented` available in `sys.path`
    pip install --user opencc-python-reimplemented
(The package is not in the product's dependency set — the fold runs once per content
change, not at runtime — so it intentionally has no lockfile entry anywhere.)

Usage:
    python scripts/gen-simplified-arms.py            # rewrite the two arms in place
    python scripts/gen-simplified-arms.py --check    # exit 1 with a diff summary if stale (CI-usable)

The fold: hk2s (Hong Kong Traditional -> Simplified) followed by t2s (generic
Traditional -> Simplified) as a backstop, via opencc. That order matters: 台->臺,
裏->里 and friends are HK-specific mappings t2s alone misses.
"""
import io
import os
import site
import sys

# opencc is a user-scope tool on hosts where the system site-packages is read-only
# (this repo's operator host); make the user site visible before importing.
_user_site = getattr(site, 'USER_SITE', None)
if _user_site and _user_site not in sys.path:
    sys.path.append(_user_site)

try:
    import opencc  # type: ignore
except ModuleNotFoundError:
    print('opencc-python-reimplemented is not installed.', file=sys.stderr)
    print('  pip install --user opencc-python-reimplemented', file=sys.stderr)
    print('The zh-CN arms must be regenerated with the same fold that produced them.', file=sys.stderr)
    sys.exit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DICT = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'i18n', 'dict.ts')
SRC_TRUST = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'i18n', 'trust-labels.ts')
OUT_DICT = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'i18n', 'dict-cn.ts')
OUT_TRUST = os.path.join(ROOT, 'apps', 'web', 'src', 'lib', 'i18n', 'trust-labels-cn.ts')

HK2S = opencc.OpenCC('hk2s')
T2S = opencc.OpenCC('t2s')


def fold(text: str) -> str:
    return T2S.convert(HK2S.convert(text))


def slice_block(src: str, start_needle: str, end_needle: str) -> str:
    i = src.find(start_needle)
    if i == -1:
        raise SystemExit(f'block not found: {start_needle!r}')
    end = src.find(end_needle, i)
    if end == -1:
        raise SystemExit(f'block end not found after: {start_needle!r}')
    return src[i:end + len(end_needle)]


def render_trust(src: str) -> str:
    zh = slice_block(src, 'const zhLabels: UiLabels = {', '\n};\n')
    zh_cn = fold(zh).replace("'zh-HK'", "'zh-CN'")
    body = zh_cn[len('const zhLabels: UiLabels = {'):]
    return (
        '/** GENERATED Simplified-Chinese trust labels — fold of zhLabels via opencc-python-reimplemented (hk2s+t2s). DO NOT EDIT BY HAND. */\n'
        "import type { UiLabels } from './trust-labels';\n"
        "import { formatDistance, formatRelativeDay, formatTravelMinutes } from '../format';\n"
        '\n'
        'export const zhCNLabels: UiLabels = {'
        + body
    )


def render_dict(src: str) -> str:
    zh_hk = slice_block(src, 'const zhHK: Dict = {', '\n};\n')
    zh_cn = fold(zh_hk).replace(": 'zh-HK'", ": 'zh-CN'")
    body = zh_cn[len('const zhHK: Dict = {'):]
    return (
        '/** GENERATED Simplified-Chinese dictionary — fold of zhHK via opencc-python-reimplemented (hk2s+t2s). DO NOT EDIT BY HAND. */\n'
        "import type { Dict } from './dict';\n"
        '\n'
        'export const zhCN: Dict = {'
        + body
    )


def main() -> int:
    check_only = '--check' in sys.argv[1:]
    targets = []

    with io.open(SRC_TRUST, encoding='utf-8') as fh:
        targets.append((OUT_TRUST, render_trust(fh.read())))
    with io.open(SRC_DICT, encoding='utf-8') as fh:
        targets.append((OUT_DICT, render_dict(fh.read())))

    stale = []
    for out_path, rendered in targets:
        if os.path.exists(out_path):
            with io.open(out_path, encoding='utf-8') as fh:
                current = fh.read().replace('\r\n', '\n')
            if current == rendered.replace('\r\n', '\n'):
                print('in lockstep:', os.path.relpath(out_path, ROOT))
                continue
        if check_only:
            stale.append(os.path.relpath(out_path, ROOT))
            continue
        with io.open(out_path, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(rendered)
        print('regenerated:', os.path.relpath(out_path, ROOT))

    if check_only and stale:
        print('STALE — regenerate with `python scripts/gen-simplified-arms.py`:', file=sys.stderr)
        for path in stale:
            print('  ', path, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
