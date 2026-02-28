import { type Prop } from 'lib';
import { type ChatPlugin } from 'lib/chat/interfaces';
import { fenColor, uciToMove } from 'lib/game/chess';
import { storedBooleanPropWithEffect } from 'lib/storage';
import { mainlineNodeList } from 'lib/tree/ops';
import { cmnToggleWrapProp } from 'lib/view/cmn-toggle';
import { hl, type VNode, getChessground, initMiniBoardWith, onInsert, spinnerVdom } from 'lib/view';
import type { Color } from 'chessops';
import type AnalyseCtrl from '@/ctrl';
import { type ChapterId } from '../interfaces';
import { type CloudEval, type MultiCloudEval, renderScore } from '../multiCloudEval';

type BoardConfig = CgConfig & { lastUci?: Uci };

export class LiveboardPlugin implements ChatPlugin {
  private animate = false;
  private board: BoardConfig | undefined;
  private isCheckmate = false;
  key = 'liveboard';
  name = i18n.broadcast.liveboard;
  kidSafe = true;
  redraw: Redraw;
  showEval: Prop<boolean>;

  constructor(
    readonly ctrl: AnalyseCtrl,
    readonly isDisabled: () => boolean,
    private chapter: ChapterId | undefined,
    private readonly cloudEval: MultiCloudEval | undefined,
  ) {
    this.showEval = storedBooleanPropWithEffect('analyse.multiboard.showEval', true, () => {
      ctrl.redraw();
    });
  }

  reset = () => {
    this.chapter = undefined;
    this.board = undefined;
    this.isCheckmate = false;
    this.animate = false;
  };

  setChapterId(id: ChapterId) {
    if (id === this.chapter) return;
    this.reset();
    this.chapter = id;
  }

  private renderEvalGauge(
    cloudEval: MultiCloudEval,
    fen: FEN,
    orientation: Color,
    isCheckmate: boolean,
  ): VNode {
    const isBlack = orientation === 'black';
    const tag =
      `span.mini-game__gauge` +
      (isBlack ? '.mini-game__gauge--flip' : '') +
      (isCheckmate ? '.mini-game__gauge--set' : '');
    const chapterId = this.chapter;

    if (isCheckmate) {
      return hl(tag, { attrs: { title: 'Checkmate' } }, [
        hl('span.mini-game__gauge__black', {
          attrs: { style: `height: ${fenColor(fen) === 'white' ? 100 : 0}%` },
        }),
        hl('tick'),
      ]);
    }

    return hl(
      tag,
      {
        attrs: { 'data-id': chapterId },
        hook: {
          ...onInsert(cloudEval.observe),
          postpatch(old, vnode) {
            const elm = vnode.elm as HTMLElement;
            const prevCloud: CloudEval | undefined = old.data?.cloud;
            const cev = cloudEval.getCloudEval(fen) || prevCloud;
            if (cev?.chances !== prevCloud?.chances) {
              const black = elm.querySelector<HTMLElement>('.mini-game__gauge__black');
              if (black)
                black.style.height = `${Math.round(((1 - (cev?.chances || 0)) / 2) * 100)}%`;
              if (cev) {
                elm.title = renderScore(cev);
                elm.classList.add('mini-game__gauge--set');
              }
            }
            vnode.data!.cloud = cev;
          },
        },
      },
      [hl('span.mini-game__gauge__black'), hl('tick')],
    );
  }

  view(): VNode {
    const path = this.ctrl.study?.data.chapter.relayPath;
    const tree = this.ctrl.tree;
    const localMainline = mainlineNodeList(tree.root);
    const node = localMainline[localMainline.length - 1];

    this.isCheckmate = false;
    if (path) {
      const pathNode = tree.nodeAtPath(path);
      this.isCheckmate = !!pathNode.outcome();
      this.board = {
        fen: pathNode.fen,
        check: !!pathNode.check() && fenColor(pathNode.fen),
        lastUci: pathNode.uci,
      };
    } else if (this.chapter && !this.board) {
      const preview = this.ctrl.study?.chapters.list.get(this.chapter);
      if (!preview) return spinnerVdom();
      this.isCheckmate = preview.check === '#';
      this.board = {
        fen: preview.fen,
        lastUci: preview.lastMove,
        check: !!preview.check && fenColor(preview.fen),
      };
    }

    if (!this.board) {
      this.isCheckmate = !!node.outcome?.();
      this.board = { fen: node.fen, lastUci: node.uci, check: !!node.check() && fenColor(node.fen) };
    }

    this.board.animation = { enabled: this.animate };
    this.board.lastMove = uciToMove(this.board.lastUci);
    this.board.orientation = this.ctrl.bottomColor();
    this.animate = true;

    const fen = this.board.fen!;
    const orientation = this.board.orientation as Color;
    const activeCloudEval = this.cloudEval && this.showEval() ? this.cloudEval : undefined;

    return hl('div.chat-liveboard', [
      hl('span.cg-gauge', [
        activeCloudEval ? this.renderEvalGauge(activeCloudEval, fen, orientation, this.isCheckmate) : undefined,
        hl('div.chat-liveboard__board.is2d', {
          hook: {
            insert: (vn: VNode) => initMiniBoardWith(vn.elm as HTMLElement, this.board!),
            update: (_, vn: VNode) => {
              getChessground(vn.elm as HTMLElement)?.set(this.board!);
              this.animate = true;
            },
          },
        }),
      ]),
      this.cloudEval
        ? hl('div.chat-liveboard__options', [
            cmnToggleWrapProp({
              id: 'liveboard-eval',
              name: i18n.study.showEvalBar,
              prop: this.showEval,
              redraw: this.ctrl.redraw,
            }),
          ])
        : undefined,
    ]);
  }
}
