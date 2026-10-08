import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSignIn } from "./claude-sign-in";

test("phone OAuth callback is relayed to the CLI with state validation and verified credentials, without pasted codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mondash-phone-sign-in-"));
  const executable = join(directory, "claude");
  const credentials = join(directory, "signed-in");
  await writeFile(
    executable,
    `#!${process.execPath}
import {existsSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if(process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:existsSync(${JSON.stringify(credentials)})}));process.exit(existsSync(${JSON.stringify(credentials)})?0:1);}
const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
  const url=new URL(request.url);
  if(url.pathname!=='/callback'||url.searchParams.get('state')!=='state')return new Response('Invalid callback',{status:400});
  if(url.searchParams.get('code')!=='accepted'){setTimeout(()=>process.exit(1),100);return new Response('Private provider response',{status:400});}
  await new Promise(r=>setTimeout(r,100));
  writeFileSync(${JSON.stringify(credentials)},'signed in');
  setTimeout(()=>process.exit(0),100);
  return new Response(null,{status:302,headers:{location:'https://platform.claude.com/oauth/code/success'}});
}});
const automatic=new URL('https://claude.com/cai/oauth/authorize?code=true&code_challenge=challenge&state=state');
automatic.searchParams.set('redirect_uri','http://localhost:'+server.port+'/callback');
const manual=new URL(automatic);manual.searchParams.set('redirect_uri','https://platform.claude.com/oauth/code/callback');
console.log('Help: https://code.claude.com/docs');console.log(manual.href);
execFileSync(process.env.BROWSER,[automatic.href]);
`,
    { mode: 0o700 },
  );
  const signIn = createClaudeSignIn(async () => executable);
  try {
    const first = signIn.start();
    assert.equal(signIn.start(), first);
    const waiting = await first;
    assert.equal(waiting.state, "waiting");
    const callback = new URL(new URL(waiting.url!).searchParams.get("redirect_uri")!);
    assert.equal(callback.hostname, "localhost", "the browser gets the automatic callback, not the manual code page");
    assert.equal(callback.pathname, "/callback");
    await assert.rejects(signIn.callback("unknown", "accepted", "state"), /no longer available/);
    await assert.rejects(signIn.callback(waiting.id, "accepted", "wrong-state"), /does not match/);
    await assert.rejects(access(credentials), "a mismatched callback must not reach the CLI");
    const failed = await signIn.callback(waiting.id, "wrong-code", "state");
    assert.equal(failed.state, "error");
    assert.ok(!JSON.stringify(failed).includes("Private provider response"));
    const retried = await signIn.start();
    assert.notEqual(retried.id, waiting.id);
    const finishing = signIn.callback(retried.id, "accepted", "state");
    assert.equal((await signIn.start()).state, "verifying");
    const connected = await finishing;
    assert.equal(connected.state, "connected");
    assert.equal(signIn.read(retried.id).state, "connected");
    assert.equal((await signIn.callback(retried.id, "accepted", "state")).state, "connected");
  } finally {
    await signIn.close();
    await rm(directory, { recursive: true, force: true });
  }
});
