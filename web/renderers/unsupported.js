// v2.48.1 placeholder for a card this version cannot draw (server/config/tolerate.js turns a card of an unknown
// type -- or one drawing a target whose source type is unknown -- into { type: 'unsupported', unsupported_type,
// target?, title? }). A small grey card in the same grid slot: one line saying what it is, one saying what was
// skipped. One column wide and never stretched, so it cannot push its row taller than its neighbours make it.
import { card, esc } from './common.js';
import { cv, t } from '../i18n.js';

export function renderUnsupported(gridCard, index) {
  const type = String(gridCard.unsupported_type || '?');
  const title = t('unsupported_title', type);
  const was = cv(gridCard, 'title');
  const note = t('unsupported_note', gridCard.target || '', was || '');
  return card({
    key: `unsupported:${index}:${type}`,
    title,
    kind: 'unsupported',
    tagShort: null,
    body: `<div class="unsup-note fit" title="${esc(note)}">${esc(note)}</div>`,
  });
}
