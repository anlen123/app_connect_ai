import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** RPC-compatible questions; unlike custom TUI widgets these work on Android. */
export default function mobileUI(pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: 'lan_ask_user', label: 'Ask on phone',
    description: 'Ask the user a question in the connected Android/desktop client and wait for their answer. Use this instead of custom terminal-only UI when you need clarification, a choice or user authorization. Supply options for a single choice; omit options for free text.',
    parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 12 })) }),
    async execute(_id, params, signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error('Interactive client required');
      if (signal?.aborted) throw new Error('Cancelled');
      const answer = params.options ? await ctx.ui.select(params.question, params.options) : await ctx.ui.input(params.question);
      return { content: [{ type: 'text', text: answer === undefined ? 'User cancelled the question.' : `User answer: ${answer}` }], details: { cancelled: answer === undefined } };
    },
  }));
  // A deterministic operator command also makes the real RPC interaction path testable.
  pi.registerCommand('lan-check', { description: 'Test mobile choice delivery', handler: async (_args, ctx) => { const value = await ctx.ui.select('局域网交互检查', ['继续', '取消']); ctx.ui.notify(`选择结果：${value ?? '取消'}`, 'info'); } });
}
