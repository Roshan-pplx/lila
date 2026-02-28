import * as licon from '../licon';
import * as enhance from '../richText';
import { userLink } from '../view/userLink';
import * as spam from './spam';
import type { Line } from './interfaces';
import { h, thunk, type VNode, type VNodeData } from 'snabbdom';
import { lineAction as modLineAction, flagReport } from './moderation';
import { presetView } from './preset';
import type { ChatCtrl } from './chatCtrl';
import { tempStorage } from '../storage';
import { pubsub } from '../pubsub';
import { alert } from '../view/dialogs';
import { enter } from '@/view';

const whisperRegex = /^\/[wW](?:hisper)?\s/;
const scrollState = { pinToBottom: true, lastScrollTop: 0 };

// ---------------------------------------------------------------------------
// Relay position sentinel
// ---------------------------------------------------------------------------
// A sentinel is appended to outgoing message text in chatCtrl.post() whenever
// the relay context provides position data.  The format is:
//   \x03<chapterId>:<ply>\x03
//
// \x03 (ETX – End of Text) is a non-printable ASCII control character that is
// invisible in normal text rendering and is extremely unlikely to appear in
// user-generated chat messages.  The chapter ID is an 8-character alphanumeric
// Lila ID; ply is an integer up to 4 digits (max 9999 half-moves ≈ 5000 moves).
//
// The full sentinel is at most 1 + 8 + 1 + 4 + 1 = 15 characters, keeping the
// combined message well within the 140-char limit for all realistic inputs.
// ---------------------------------------------------------------------------
const SENTINEL_REGEX = /\x03([A-Za-z0-9]{8}):(\d{1,4})\x03/;

interface ParsedLine {
  text: string;
  chapterId?: string;
  ply?: number;
}

/** Strip the sentinel from the raw line text and return its components. */
function parseSentinel(raw: string): ParsedLine {
  const match = raw.match(SENTINEL_REGEX);
  if (match) {
    return {
      text: raw.replace(SENTINEL_REGEX, '').trimEnd(),
      chapterId: match[1],
      ply: parseInt(match[2], 10),
    };
  }
  return { text: raw };
}

/**
 * Convert a half-move ply to a human-readable chess move label.
 * e.g. ply 0 → "start", ply 1 → "1.", ply 2 → "1…", ply 3 → "2."
 */
function plyToMoveStr(ply: number): string {
  if (ply <= 0) return 'start';
  const moveNum = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${moveNum}.` : `${moveNum}\u2026`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export default function (ctrl: ChatCtrl): Array<VNode | undefined> {
  if (!ctrl.chatEnabled()) return [];
  const hasMod = !!ctrl.moderation;
  const vnodes = [
    h(
      `ol.mchat__messages.chat-v-${ctrl.vm.domVersion}${hasMod ? '.as-mod' : ''}`,
      {
        attrs: { role: 'log', 'aria-live': 'polite', 'aria-atomic': 'false' },
        hook: {
          insert(vnode) {
            const el = vnode.elm as HTMLElement;
            const $el = $(el).on('click', 'a.jump', (e: Event) => {
              const ply = (e.target as HTMLElement).getAttribute('data-ply');
              if (ply) pubsub.emit('jump', ply);
            });
            $el.on('click', '.reply', (e: Event) => {
              const el = e.target as HTMLElement;
              const username = el.parentElement
                ?.querySelector<HTMLLinkElement>('.user-link')
                ?.getAttribute('href')
                ?.slice(3);
              const input = el.closest('.mchat')?.querySelector<HTMLInputElement>('input.mchat__say');
              if (username && input) prependChatInput(input, `@${username} `);
            });
            if (hasMod)
              $el.on('click', '.mod', (e: Event) =>
                ctrl.moderation?.open((e.target as HTMLElement).parentNode as HTMLElement),
              );
            else $el.on('click', '.flag', (e: Event) => flagReport(ctrl, e.target as HTMLElement));

            // Navigate to the game & move embedded in a relay position badge.
            $el.on('click', '.relay-pos', (e: Event) => {
              const badge = (e.target as HTMLElement).closest('.relay-pos') as HTMLElement | null;
              if (!badge) return;
              const chapterId = badge.getAttribute('data-chapter');
              const plyStr = badge.getAttribute('data-ply');
              if (chapterId && plyStr) {
                ctrl.opts.onRelayNav?.(chapterId, parseInt(plyStr, 10));
              }
            });

            el.addEventListener('scroll', () => {
              if (el.scrollTop < scrollState.lastScrollTop) scrollState.pinToBottom = false;
              else if (el.scrollTop + el.clientHeight > el.scrollHeight - 10) scrollState.pinToBottom = true;
              scrollState.lastScrollTop = el.scrollTop;
            });

            requestAnimationFrame(() => (el.scrollTop = el.scrollHeight));
          },
          postpatch: (_, vnode) => {
            const el = vnode.elm as HTMLElement;
            if (!scrollState.pinToBottom) return;

            if (document.visibilityState === 'hidden') el.scrollTop = el.scrollHeight;
            else if (el.scrollTop + el.clientHeight < el.scrollHeight)
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });

            scrollState.lastScrollTop = el.scrollTop;
          },
        },
      },
      selectLines(ctrl).map(line => renderLine(ctrl, line)),
    ),
    renderInput(ctrl),
  ];
  const presets = presetView(ctrl.preset);
  if (presets) vnodes.push(presets);
  return vnodes;
}

function renderInput(ctrl: ChatCtrl): VNode | undefined {
  if (!ctrl.vm.writeable) return;
  if ((ctrl.data.loginRequired && !ctrl.data.userId) || ctrl.data.restricted)
    return h('input.mchat__say', {
      attrs: { placeholder: i18n.site.loginToChat, disabled: true },
    });
  let placeholder: string;
  if (ctrl.vm.timeout) placeholder = i18n.site.youHaveBeenTimedOut;
  else if (ctrl.opts.blind) placeholder = 'Chat';
  else placeholder = i18n.site.talkInChat;
  return h('input.mchat__say', {
    attrs: {
      placeholder,
      autocomplete: 'off',
      enterkeyhint: 'send',
      maxlength: 140,
      disabled: ctrl.vm.timeout || !ctrl.vm.writeable,
      'aria-label': 'Chat input',
    },
    hook: {
      insert(vnode) {
        setupHooks(ctrl, vnode.elm as HTMLInputElement);
      },
    },
  });
}

function prependChatInput(chatInput: HTMLInputElement, prefix: string): void {
  if (!chatInput.value.includes(prefix)) chatInput.value = prefix + chatInput.value;
  chatInput.focus();
  chatInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
}

let mouchListener: EventListener;

const setupHooks = (ctrl: ChatCtrl, chatEl: HTMLInputElement) => {
  const inner = tempStorage.make(`chat.input`);
  const storage = {
    get: (): string | undefined => {
      const v = inner.get();
      if (v) {
        try {
          const parsed = JSON.parse(v);
          if (parsed[0] === (ctrl.data.opponentId || '')) {
            return parsed[1] as string;
          }
        } catch {
          console.log(`Could not parse "chat.input" value ${v}`);
        }
      }
      return;
    },
    set: (txt: string) => {
      inner.set(JSON.stringify([ctrl.data.opponentId || '', txt]));
    },
    inner,
  };
  const previousText = storage.get();
  if (previousText) {
    chatEl.value = previousText;
    chatEl.focus();
    if (!ctrl.opts.public && previousText.match(whisperRegex)) chatEl.classList.add('whisper');
  } else if (ctrl.vm.autofocus) chatEl.focus();

  chatEl.addEventListener(
    'keydown',
    enter(target => {
      setTimeout(() => {
        const el = target as HTMLInputElement,
          txt = el.value,
          pub = ctrl.opts.public;

        if (txt === '')
          $('.input-move input').each(function (this: HTMLInputElement) {
            this.focus();
          });
        else {
          if (!ctrl.opts.kobold) spam.selfReport(txt);
          if (pub && spam.hasTeamUrl(txt)) alert("Please don't advertise teams in the chat.");
          else {
            scrollState.pinToBottom = true;
            ctrl.post(txt);
          }
          el.value = '';
          storage.inner.remove();
          if (!pub) el.classList.remove('whisper');
        }
      });
    }),
  );

  chatEl.addEventListener('input', (e: KeyboardEvent) =>
    setTimeout(() => {
      const el = e.target as HTMLInputElement,
        txt = el.value;

      el.removeAttribute('placeholder');
      if (!ctrl.opts.public) el.classList.toggle('whisper', !!txt.match(whisperRegex));
      storage.set(txt);
    }),
  );

  site.mousetrap.bind(
    'c',
    () => document.querySelector<HTMLInputElement>('input.mchat__say')?.focus(),
    undefined,
    false,
  );

  // Ensure clicks remove chat focus.
  // See https://github.com/lichess-org/lila/pull/5323

  const mouchEvents = ['touchstart', 'mousedown'];

  if (mouchListener)
    mouchEvents.forEach(event => document.body.removeEventListener(event, mouchListener, { capture: true }));

  mouchListener = (e: MouseEvent) => {
    if (!e.shiftKey && e.buttons !== 2 && e.button !== 2 && e.target !== chatEl) chatEl.blur();
  };

  chatEl.onfocus = () =>
    mouchEvents.forEach(event =>
      document.body.addEventListener(event, mouchListener, { passive: true, capture: true }),
    );

  chatEl.onblur = () =>
    mouchEvents.forEach(event => document.body.removeEventListener(event, mouchListener, { capture: true }));
};

const sameLines = (l1: Line, l2: Line) => l1.d && l2.d && l1.u === l2.u;

function selectLines(ctrl: ChatCtrl): Array<Line> {
  const ls: Array<Line> = [];
  let prev: Line | undefined;
  ctrl.data.lines.forEach(line => {
    if (
      !line.d &&
      (!prev || !sameLines(prev, line)) &&
      (!line.r || (line.u || '').toLowerCase() === ctrl.data.userId) &&
      !spam.skip(line.t)
    )
      ls.push(line);
    prev = line;
  });
  return ls;
}

const updateText = (opts?: enhance.EnhanceOpts) => (oldVnode: VNode, vnode: VNode) => {
  if ((vnode.data as VNodeData).lichessChat !== (oldVnode.data as VNodeData).lichessChat)
    (vnode.elm as HTMLElement).innerHTML = enhance.enhance((vnode.data as VNodeData).lichessChat, opts);
};

const profileLinkRegex = /(https:\/\/)?lichess\.org\/@\/([a-zA-Z0-9_-]+)/g;

const processProfileLink = (text: string) => text.replace(profileLinkRegex, '@$2');

function renderText(t: string, opts?: enhance.EnhanceOpts) {
  const processedText = processProfileLink(t);
  if (enhance.isMoreThanText(processedText)) {
    const hook = updateText(opts);
    return h('t', { lichessChat: processedText, hook: { create: hook, update: hook } });
  }
  return h('t', processedText);
}

const userThunk = (name: string, title?: string, patronColor?: PatronColor, flair?: Flair) =>
  userLink({ name, title, patronColor, line: !!patronColor, flair, online: !!patronColor });

const actionIcons = (ctrl: ChatCtrl, line: Line): Array<VNode | null> => {
  if (!ctrl.data.userId || !line.u || ctrl.data.userId === line.u) return [];
  const icons = [];
  if (ctrl.canPostArbitraryText() && !ctrl.data.resourceId.startsWith('game'))
    icons.push(
      h('action.reply', {
        attrs: { 'data-icon': licon.Back, title: 'Reply' },
      }),
    );
  icons.push(
    ctrl.moderation
      ? modLineAction()
      : h('action.flag', {
          attrs: { 'data-icon': licon.CautionTriangle, title: 'Report', 'data-text': line.t },
        }),
  );
  return icons;
};

/**
 * Render a small clickable badge showing the move number that was embedded in
 * the message.  Only rendered when onRelayNav is wired up (i.e. in a relay
 * broadcast context) and the line actually contains position data.
 */
function renderRelayPosBadge(parsed: ParsedLine): VNode | undefined {
  if (!parsed.chapterId || parsed.ply === undefined) return undefined;
  const moveLabel = plyToMoveStr(parsed.ply);
  return h(
    'span.relay-pos',
    {
      attrs: {
        'data-chapter': parsed.chapterId,
        'data-ply': parsed.ply,
        title: `Go to move ${moveLabel}`,
        role: 'button',
      },
    },
    [h('i', { attrs: { 'data-icon': licon.DiscBig } }), moveLabel],
  );
}

function renderLine(ctrl: ChatCtrl, line: Line): VNode {
  const parsed = parseSentinel(line.t);
  const textNode = renderText(parsed.text, ctrl.opts.enhance);
  // Only show the position badge when the relay nav callback is available
  // (i.e. we are in a broadcast context and not just a regular study/game chat).
  const posBadge = ctrl.opts.onRelayNav ? renderRelayPosBadge(parsed) : undefined;

  if (line.u === 'lichess') return h('li.system', textNode);

  if (line.c) return h('li', [h('span.color', '[' + line.c + ']'), textNode, ...(posBadge ? [' ', posBadge] : [])]);

  const userNode = thunk('a', line.u, userThunk, [line.u, line.title, line.pc, line.f]);
  const userId = line.u?.toLowerCase();

  const myUserId = ctrl.data.userId;
  const mentioned =
    !!myUserId &&
    !!parsed.text
      .match(enhance.userPattern)
      ?.find(mention => mention.trim().toLowerCase() === `@${ctrl.data.userId}`);

  return h(
    'li',
    {
      class: {
        me: userId === myUserId,
        host: !!(userId && ctrl.data.hostIds?.includes(userId)),
        mentioned,
        'has-relay-pos': !!posBadge,
      },
    },
    [...actionIcons(ctrl, line), userNode, ' ', textNode, ...(posBadge ? [' ', posBadge] : [])],
  );
}
