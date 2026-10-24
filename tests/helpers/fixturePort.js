// Keep the entire random fixture pool outside Fetch's prohibited ports.
export function randomFixturePort() {
  return 11000 + Math.floor(Math.random() * 900);
}
