/**
 * squeeze plugin e2e session harness — simulates an opencode session without
 * a live opencode process or model.
 *
 * Transcript contract (epic architecture):
 *   user prose → hook.pre → compressed SQZ envelope → "model"
 *   "model" SQZ output → hook.post → expanded prose → user
 *
 * The harness drives the same pure core functions the opencode plugin uses,
 * with SDK-shaped message/part objects, and records every stage so tests can
 * assert the full round trip plus every degradation path.
 */

import { processUserText, processAssistantText, type PluginDeps, type ProcessUserOptions } from "./core.js";

export interface HarnessTurn {
  /** Original user prose. */
  userProse: string;
  /** What the model receives (SQZ envelope, or prose when uncompressed). */
  modelInput: string;
  /** Raw assistant output as produced by the model (may be SQZ). */
  assistantOutput: string;
  /** What the user sees rendered (expanded prose, or raw when expand off). */
  userOutput: string;
}

export class SqueezeHarness {
  private lexiconInjected = false;
  private readonly turns: HarnessTurn[] = [];

  constructor(
    private readonly deps: PluginDeps,
    private readonly opts: {
      threshold: number;
      audit: boolean;
      retries: number;
      expand: boolean;
    },
  ) {}

  get transcript(): readonly HarnessTurn[] {
    return this.turns;
  }

  /**
   * One full turn: user prose in, compressed payload to model, model replies,
   * expanded output to user.
   */
  async turn(prose: string, assistantOutput: string): Promise<HarnessTurn> {
    const userOptions: ProcessUserOptions = {
      threshold: this.opts.threshold,
      audit: this.opts.audit,
      includeLexicon: !this.lexiconInjected,
      retries: this.opts.retries,
    };
    const outcome = await processUserText(prose, this.deps, userOptions);
    this.lexiconInjected = true;

    const assistant = processAssistantText(assistantOutput, this.deps, { expand: this.opts.expand });

    const turn: HarnessTurn = {
      userProse: prose,
      modelInput: outcome.text,
      assistantOutput,
      userOutput: assistant.text,
    };
    this.turns.push(turn);
    return turn;
  }
}