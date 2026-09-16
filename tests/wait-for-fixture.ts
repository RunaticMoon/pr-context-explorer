// Test-only: a failed operation must not leave its observer awaiting a gate
// which the operation will never reach. Callers still release gates in finally.
export async function waitForFixture(
  gate: Promise<unknown>,
  operation?: Promise<unknown>,
  timeoutMs = 10000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("fixture gate was not reached")),
          timeoutMs,
        );
      }),
      ...(operation
        ? [
            operation.then(
              () => {
                throw Error("fixture operation completed before its gate");
              },
              () => {
                throw Error("fixture operation failed before its gate");
              },
            ),
          ]
        : []),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
