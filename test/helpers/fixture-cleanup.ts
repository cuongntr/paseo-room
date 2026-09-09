export async function removeFixtureRootAfterConfirmedTermination(
  terminationConfirmed: boolean,
  removeRoot: () => Promise<void>,
): Promise<boolean> {
  if (!terminationConfirmed) return false;
  await removeRoot();
  return true;
}
