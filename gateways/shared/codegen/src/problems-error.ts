/**
 * Everything wrong at once, one problem a line under a header: a command prints a message and
 * nothing else, so one run has to say all of it. `after` follows the list, such as what to do.
 */
export class ProblemsError extends Error {
  readonly problems: readonly string[];

  constructor(
    header: string,
    problems: readonly string[],
    after: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(
      [header, ...problems.map((problem) => `  - ${problem}`), ...after].join(
        "\n",
      ),
      options,
    );
    this.name = new.target.name;
    this.problems = problems;
  }
}
