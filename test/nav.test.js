import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { navFor } from '../src/core/nav.js';
import { loadUser } from '../src/core/auth.js';
import { db } from '../src/core/db.js';
import { makeUser, loginAs, cleanup } from './helpers.js';

after(cleanup);

// Every page in the menu lights up its own menu item, and only that one. (A page that passes its own
// `path` to the view would hide it: res.locals.path is what the menu reads.)
test('each menu page highlights its own menu item', async () => {
  const agent = await loginAs(createApp(), await makeUser(88, ['admin']));
  const user = await loadUser((await db('users').where({ phone: '+254700000088' }).first('id')).id);
  const hrefs = navFor(user).flatMap((g) => g.items).filter((i) => i.ready).map((i) => i.href);
  const wrong = [];
  for (const href of hrefs) {
    const res = await agent.get(href);
    if (res.status !== 200) { wrong.push(`${href}: status ${res.status}`); continue; }
    const active = [...res.text.matchAll(/<a class="jt-nav-link active" href="([^"]+)"/g)].map((m) => m[1]);
    if (active.length !== 1 || active[0] !== href) wrong.push(`${href}: highlighted ${JSON.stringify(active)}`);
  }
  assert.deepEqual(wrong, []);
});
