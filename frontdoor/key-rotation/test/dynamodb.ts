import {
  type AttributeValue,
  type DynamoDBClient,
  ScanCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";

type Item = Record<string, AttributeValue>;

/**
 * DynamoDB, in memory, for the two commands rotation sends. A transaction is written whole or not
 * at all, refuses two actions on one item, and holds a Put to the two conditions rotation writes.
 */
export class FakeDynamoDB {
  readonly tables = new Map<string, Map<string, Item>>();
  readonly commands: string[] = [];
  /** Refuses the next transaction, as DynamoDB would for a reason of its own. */
  failNext = false;
  /** The most items a scan's page holds, as DynamoDB ends a page at 1 MB. */
  pageSize = Number.POSITIVE_INFINITY;

  table(name: string): Map<string, Item> {
    let table = this.tables.get(name);
    if (table === undefined) {
      table = new Map();
      this.tables.set(name, table);
    }
    return table;
  }

  /** By key, as a scan's order is DynamoDB's own. */
  items(name: string): Item[] {
    return [...this.table(name)]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, item]) => item);
  }

  readonly client = {
    send: (command: unknown) => this.send(command),
  } as unknown as Pick<DynamoDBClient, "send">;

  private send(command: unknown): Promise<unknown> {
    if (command instanceof ScanCommand) {
      const { TableName, ExclusiveStartKey, ConsistentRead } = command.input;
      this.commands.push(
        `Scan ${String(TableName)}${ConsistentRead === true ? " consistently" : ""}`,
      );
      const items = this.items(String(TableName));
      const start = ExclusiveStartKey?.keyId?.S;
      const from =
        start === undefined
          ? 0
          : items.findIndex((item) => item.keyId?.S === start) + 1;
      const page = items.slice(from, from + this.pageSize);
      const last = page.at(-1);
      return Promise.resolve({
        Items: page,
        ...(from + page.length < items.length &&
          last?.keyId !== undefined && {
            LastEvaluatedKey: { keyId: last.keyId },
          }),
      });
    }
    if (!(command instanceof TransactWriteItemsCommand)) {
      return Promise.reject(new Error("unexpected command"));
    }
    this.commands.push("TransactWriteItems");
    const actions = command.input.TransactItems ?? [];
    const targets = actions.map((action) => {
      const name = action.Put?.TableName ?? action.Delete?.TableName ?? "";
      const keyId = action.Put?.Item?.keyId?.S ?? action.Delete?.Key?.keyId?.S;
      return `${name} ${String(keyId)}`;
    });
    if (new Set(targets).size !== targets.length) {
      return Promise.reject(
        Object.assign(
          new Error(
            "Transaction request cannot include multiple operations on one item",
          ),
          {
            name: "ValidationException",
          },
        ),
      );
    }
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("InternalServerError"));
    }

    const reasons = actions.map((action) => {
      const put = action.Put;
      if (put?.ConditionExpression === undefined) return { Code: "None" };
      const current = this.table(String(put.TableName)).get(
        String(put.Item?.keyId?.S),
      );
      const holds =
        put.ConditionExpression === "attribute_not_exists(keyId)"
          ? current === undefined
          : put.ConditionExpression === "version = :seen" &&
            current?.version?.N !== undefined &&
            current.version.N === put.ExpressionAttributeValues?.[":seen"]?.N;
      return { Code: holds ? "None" : "ConditionalCheckFailed" };
    });
    if (reasons.some(({ Code }) => Code !== "None")) {
      return Promise.reject(
        new TransactionCanceledException({
          message: "Transaction cancelled",
          $metadata: {},
          CancellationReasons: reasons,
        }),
      );
    }

    for (const action of actions) {
      if (action.Put !== undefined) {
        const item = action.Put.Item ?? {};
        this.table(String(action.Put.TableName)).set(
          String(item.keyId?.S),
          item,
        );
      } else if (action.Delete !== undefined) {
        this.table(String(action.Delete.TableName)).delete(
          String(action.Delete.Key?.keyId?.S),
        );
      }
    }
    return Promise.resolve({});
  }
}
