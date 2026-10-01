import { describe, expect, it } from 'vitest';
import { mask, tail } from '../src/runtime-plugin/server/attention/mask.js';

describe('masking', () => {
  it('masks credentials, tokens, secrets in assignments, URL user-info and queries', () => {
    const cases: [string, string][] = [
      ['Authorization: Bearer abcdefghijklmnop1234', 'Authorization: Bearer [secret]'],
      ['key sk-proj-AbCdEfGhIjKlMnOpQrSt used', 'key [secret] used'],
      ['token ghp_abcdefghijklmnopqrstuvwxyz0123', 'token [secret]'],
      ['glpat-abcdefghijklmnopqrst1', '[secret]'],
      ['DATAGERRY_PASSWORD=hunter2hunter2', 'DATAGERRY_PASSWORD=[secret]'],
      ['api_key: "abc123"', 'api_key: [secret]'],
      ['https://user:pass@git.example.test/repo.git', 'https://[user]@git.example.test/repo.git'],
      ['see https://ci.example.test/run?token=zzz&x=1 now', 'see https://ci.example.test/run?[query] now'],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', '[jwt]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[private key]'],
    ];
    for (const [input, expected] of cases) expect(mask(input)).toBe(expected);
  });

  it('masks a credential a plain word names, but not the word in a sentence', () => {
    const cases: [string, string][] = [
      ['password: hunter2', 'password: [secret]'],
      ['token=abc', 'token=[secret]'],
      ['accessToken: abc', 'accessToken: [secret]'],
      ['TOKEN: abc', 'TOKEN: [secret]'],
      ['curl -H "Authorization: Basic dXNlcjpwYXNz" https://x', 'curl -H "Authorization: Basic [secret]" https://x'],
      ['Basic authentication is off', 'Basic authentication is off'],
      // A credential with no digit is still told from a word by its shape.
      ['use Basic dXNlcjpwYXNz', 'use Basic [secret]'],
      ['password: correctHorse', 'password: [secret]'],
      // A quoted key names a credential, as in JSON.
      ['{"password": "hunter2", "token": "abc"}', '{"password": [secret], "token": [secret]}'],
      ['Token: dGhpc2lzYWxvbmdvcGFxdWV0b2tlbg', 'Token: [secret]'],
      // Masked in live letters, and meaningless once masked (cmdb, 2026-09-30).
      ['nối theo từng người qua token Keycloak đã đổi', 'nối theo từng người qua token Keycloak đã đổi'],
      ['**Fresh sign-in to create a token:** name it', '**Fresh sign-in to create a token:** name it'],
      ['create a token: name it after the host', 'create a token: name it after the host'],
      ['the token: 5 phút', 'the token: 5 phút'],
    ];
    for (const [input, expected] of cases) expect(mask(input)).toBe(expected);
  });

  it('masks network identifiers, and leaves ordinary prose alone', () => {
    expect(mask('deploy to 10.20.30.40:8080 and dx-cmdb.cmctelecom.vn')).toBe('deploy to [ip] and [host]');
    const prose = 'Đã xong v0.1.12: sửa README.md, chạy npm run verify (594 tests pass). Chờ Human duyệt.';
    expect(mask(prose)).toBe(prose);
    expect(tail('a\n\n  b  c', 10)).toBe('a b c');
    expect(tail('0123456789abcdef', 6)).toBe('…bcdef');
  });
});
