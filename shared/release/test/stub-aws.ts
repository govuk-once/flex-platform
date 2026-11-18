// Stands in for AWS under the SDK's own clients, so a test sees each command as the SDK builds it.

export interface Sent {
  readonly command: string;
  readonly input: unknown;
}

export type Answer = (command: string, input: unknown) => unknown;

// Any of the SDK's clients: each takes middleware at the start of a call.
interface Client {
  readonly middlewareStack: {
    add(middleware: unknown, options: unknown): void;
  };
}

// Answers each call the client sends in place of AWS, before anything is signed or sent, and
// records it. An answer that throws is AWS's error.
export function answering(client: Client, answer: Answer): Sent[] {
  const sent: Sent[] = [];
  client.middlewareStack.add(
    (_next: unknown, context: { commandName: string }) =>
      (args: { input: unknown }) => {
        sent.push({ command: context.commandName, input: args.input });
        return Promise.resolve().then(() => ({
          output: {
            $metadata: {},
            ...(answer(context.commandName, args.input) as object),
          },
          response: {},
        }));
      },
    { step: "initialize", priority: "high" },
  );
  return sent;
}
