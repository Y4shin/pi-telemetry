import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface L2SessionOptions {
  dbPath: string;
  extensionFactory?: ExtensionFactory;
  responses?: unknown[];
  cwd?: string;
}

export interface L2Session {
  session: AgentSession;
  cleanup: () => Promise<void>;
}

export async function createL2Session(options: L2SessionOptions): Promise<L2Session> {
  const cwd = options.cwd ?? process.cwd();
  const faux = fauxProvider({
    provider: "pi-telemetry-test",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000,
  });

  if (options.responses) {
    faux.setResponses(options.responses.map((r) => (typeof r === "string" ? fauxAssistantMessage(r) : r)));
  } else {
    faux.setResponses([fauxAssistantMessage("Hello from pi-telemetry L2 harness.")]);
  }

  const providerFactory: ExtensionFactory = (pi: ExtensionAPI) => {
    pi.registerProvider(faux.provider.id, {
      baseUrl: "http://localhost:0",
      apiKey: "test",
      api: faux.api,
      models: faux.models,
      streamSimple: faux.provider.streamSimple,
    });
  };

  const factories = options.extensionFactory ? [providerFactory, options.extensionFactory] : [providerFactory];

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    extensionFactories: factories,
  });
  await loader.reload();

  const result = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model: faux.getModel(),
    tools: ["read", "bash"],
  });

  // The SDK does not emit session_start during createAgentSession; the host (CLI/modes)
  // emits it. Fire it manually so session-scoped extension initializers run.
  await result.session.extensionRunner.emit({ type: "session_start", reason: "startup" });

  return {
    session: result.session,
    cleanup: async () => {
      result.session.dispose();
    },
  };
}
