import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  SessionStartEvent,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

export interface L1Stub {
  readonly pi: ExtensionAPI;
  readonly events: {
    on(name: string, handler: (data: unknown) => void): void;
    emit(name: string, data: unknown): void;
  };
  readonly tools: Array<{ name: string; definition: unknown }>;
  readonly commands: Array<{ name: string; options: unknown }>;
  fire<E, R = unknown>(event: string, payload: E, ctx?: Partial<ExtensionContext>): Promise<R | undefined>;
}

export function createL1Stub(): L1Stub {
  const handlers = new Map<string, ExtensionHandler<unknown, unknown>[]>();
  const eventBus = new Map<string, ((data: unknown) => void)[]>();
  const tools: Array<{ name: string; definition: unknown }> = [];
  const commands: Array<{ name: string; options: unknown }> = [];

  const defaultContext: Partial<ExtensionContext> = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => true,
  };

  const pi = {
    on: (event: string, handler: ExtensionHandler<unknown, unknown>) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool: (definition: { name: string }) => {
      tools.push({ name: definition.name, definition });
    },
    registerCommand: (name: string, options: unknown) => {
      commands.push({ name, options });
    },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        const list = eventBus.get(name) ?? [];
        list.push(handler);
        eventBus.set(name, list);
      },
      emit: (name: string, data: unknown) => {
        for (const h of eventBus.get(name) ?? []) {
          try {
            h(data);
          } catch {
            // Event bus is fire-and-forget.
          }
        }
      },
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    events: pi.events,
    tools,
    commands,
    fire: async (event, payload, ctx) => {
      const context = { ...defaultContext, ...ctx } as ExtensionContext;
      let result: unknown;
      for (const h of handlers.get(event) ?? []) {
        result = await h(payload, context);
      }
      return result;
    },
  };
}

export type { ExtensionContext, SessionStartEvent, SessionShutdownEvent };
