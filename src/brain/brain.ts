import type { Topic } from "./router.ts";

/** Reads `signal.aborted` fresh; a plain property check gets narrowed by TS after an earlier check. */
export const aborted = (signal: AbortSignal): boolean => signal.aborted;

export interface TurnOut {
  text: (delta: string) => void;
  tool?: (name: string) => void;
}

/** One conversation backend. Each topic is its own conversation. */
export interface Brain {
  /**
   * Run one turn. Text is streamed to `onText` as it is generated so speech
   * can start before the reply is finished. `onTool` fires as soon as a tool
   * call starts, so the voice side can fill the silence. Aborting stops the
   * turn (barge-in).
   */
  turn(topic: Topic, input: string, out: TurnOut, signal: AbortSignal): Promise<void>;
  /** Get ready to answer quickly in this topic (spawn process / prime cache). */
  warm(topic: Topic): Promise<void>;
  /** Forget a topic's conversation. */
  forget(topicId: string): void;
  close(): void;
}

/**
 * Splits streamed text into speakable chunks. The first chunk is released
 * early (at a clause boundary) to cut time-to-first-audio; later chunks are
 * whole sentences, which sound better.
 */
export class SentenceChunker {
  private buf = "";
  private first = true;

  private emit: (chunk: string) => void;
  private firstMin: number;
  private maxLen: number;

  constructor(emit: (chunk: string) => void, firstMin = 24, maxLen = 280) {
    this.emit = emit;
    this.firstMin = firstMin;
    this.maxLen = maxLen;
  }

  push(delta: string): void {
    this.buf += delta;
    for (;;) {
      const cut = this.findCut();
      if (cut < 0) break;
      this.out(this.buf.slice(0, cut));
      this.buf = this.buf.slice(cut);
    }
  }

  flush(): void {
    this.out(this.buf);
    this.buf = "";
  }

  private out(s: string) {
    const t = s.trim();
    if (t) {
      this.first = false;
      this.emit(t);
    }
  }

  private findCut(): number {
    const b = this.buf;
    const sentence = /[.!?…](?=\s)|\n/g;
    let m: RegExpExecArray | null;
    while ((m = sentence.exec(b))) {
      const end = m.index + m[0].length;
      // Skip "e.g." / "v2.1" style dots: need some length before the cut.
      if (end >= (this.first ? 2 : 12)) return end;
    }
    if (this.first && b.length >= this.firstMin) {
      const clause = /[,;:—–](?=\s)/g;
      let last = -1;
      while ((m = clause.exec(b))) last = m.index + 1;
      if (last >= this.firstMin) return last;
    }
    if (b.length > this.maxLen) {
      const sp = b.lastIndexOf(" ", this.maxLen);
      return sp > 0 ? sp : this.maxLen;
    }
    return -1;
  }
}
