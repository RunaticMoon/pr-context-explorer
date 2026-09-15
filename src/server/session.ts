export const validToken = (token: string): boolean =>
  /^[a-f0-9]{64}$/.test(token);
