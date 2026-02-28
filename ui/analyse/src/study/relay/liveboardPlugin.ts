import { hl, type VNode, type MaybeVNode, getChessground, initMiniBoardWith, onInsert, spinnerVdom } from 'lib/view';
import { fenColor, uciToMove } from 'lib/game/chess';
import { type ChatPlugin } from 'lib/chat/interfaces';
import type AnalyseCtrl from '@/ctrl';
import { mainlineNodeList } from 'lib/tree/ops';
import { type ChapterId } from '../interfaces';
import { type CloudEval, type MultiCloudEval, renderScore } from '../multiCloudEval';
import { h } from 'snabbdom';

type BoardConfig = CgConfig & { lastUci?: Uci };

export class LiveboardPlugin implements ChatPlugin {
  private animate = false;
  private board: BoardConfig | undefined;
  key = 'liveboard';
  name = i18n.broadcast.liveboard;
  kidSafe = true;
  redraw: Redraw;

  constructor(
    readonly ctrl: AnalyseCtrl,
    readonly isDisabled: () => boolean,
    private chapter: ChapterId | undefined,
    private readonly cloudEval?: MultiCloudEval,
  ) {}

  reset = () => {
    this.chapter = undefined;
    this.board = undefined;
    this.animate = false;
  };

  setChapterId(id: ChapterId) {
    if (id === this.chapter) return;
    this.reset();
    this.chapter = id;
  }

  view(): VNode {
    const path = this.ctrl.study?.data.chapter.relayPath;
    const tree = this.ctrl.tree;
    const localMainline = mainlineNodeList(tree.root);
    const node = localMainline[localMainline.length - 1];
    if (path) {
      const node = tree.nodeAtPath(path);
      this.board = { fen: node.fen, check: !!node.check() && fenColor(node.fen), lastUci: node.uci };
    } else if (this.chapter && !this.board) {
      const preview = this.ctrl.study?.chapters.list.get(this.chapter);
      if (!preview) return spinnerVdom();
      this.board = {
        fen: preview.fen,
        lastUci: preview.lastMove,
        check: !!preview.check && fenColor(preview.fen),
      };
    }
    this.board ??= { fen: node.fen, lastUci: node.uci, check: !!node.check() && fenColor(node.fen) };
    this.board.animation = { enabled: this.animate };
    this.board.lastMove = uciToMove(this.board.lastUci);
    this.board.orientation = this.ctrl.bottomColor();
    this.animate = true;

    const orientation = this.board.orientation || 'white';
    const fen = this.board.fen as FEN;
    const cloudEval = this.cloudEval?.thisIfShowEval();
    const boardNode = this.board;

    return hl('div.chat-liveboard-wrap.is2d', [
      hl('div.chat-liveboard', {
        hook: {
          insert: (vn: VNode) => initMiniBoardWith(vn.elm as HTMLElement, boardNode),
          update: (_, vn: VNode) => {
            getChessground(vn.elm as HTMLElement)?.set(boardNode);
            this.animate = true;
          },
        },
      }),
      cloudEval ? liveboardEvalGauge(fen, orientation, this.chapter, cloudEval) : undefined,
    ]);
  }
}

const liveboardEvalGauge = (
  fen: FEN,
  orientation: Color,
  chapterId: ChapterId | undefined,
  cloudEval: MultiCloudEval,
): MaybeVNode => {
  const tag = `span.mini-game__gauge${orientation === 'black' ? '.mini-game__gauge--flip' : ''}`;

  return h(
    tag,
    {
      attrs: { 'data-id': chapterId || 'liveboard' },
      hook: {
        ...onInsert(cloudEval.observe),
        postpatch(old, vnode) {
          const elm = vnode.elm as HTMLElement;
          const prevNodeCloud: CloudEval | undefined = old.data?.cloud;
          const cev = cloudEval.getCloudEval(fen) || prevNodeCloud;
          if (cev?.chances !== prevNodeCloud?.chances) {
            (elm.firstChild as HTMLElement).style.height = `${Math.round(
              ((1 - (cev?.chances || 0)) / 2) * 100,
            )}%`;
            if (cev) {
              elm.title = renderScore(cev);
              elm.classList.add('mini-game__gauge--set');
            }
          }
          vnode.data!.cloud = cev;
        },
      },
    },
    [h('span.mini-game__gauge__black'), h('tick')],
  );
};
