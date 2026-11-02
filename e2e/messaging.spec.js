/**
 * The worker's router (#13 slice 2), in Chrome: an extension page that opens the ntn-rpc
 * port is welcomed, as the surface its sender is, and answered system.messagingHealth. No
 * page opens the port on its own until #35 moves a client to it, so this one opens it by
 * hand and speaks the frames a client would. A hello that finds the coordinator starting
 * is welcomed once the start is done, WELCOME_WAIT_MS (1000 ms) at most (#35).
 */

const { test, expect } = require('./harness');

/**
 * In the page: open the port, say hello as `surface`, ask for system.messagingHealth once
 * welcomed, and resolve with every frame that came back, decoded, once the answer has
 */
function askHealth(surface) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ntn-rpc' });
    const frames = [];
    port.onDisconnect.addListener(() => {
      reject(new Error(`The port closed: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'by the worker'}`));
    });
    port.onMessage.addListener(text => {
      const frame = JSON.parse(text);
      frames.push(frame);
      if (frame.frame !== 'welcome') {
        port.disconnect();
        resolve(frames);
        return;
      }
      port.postMessage(JSON.stringify({
        frame: 'request',
        requestId: 'r1',
        operation: 'system.messagingHealth',
        version: 1,
        deadline: Date.now() + 10000,
        payload: { type: 'system.messagingHealth' },
      }));
    });
    port.postMessage(JSON.stringify({
      frame: 'hello',
      protocol: { major: 1, minor: 0 },
      extensionVersion: chrome.runtime.getManifest().version,
      surface,
      sessionId: `e2e-${surface}`,
    }));
  });
}

test("the worker's router welcomes an extension page on its port and answers system.messagingHealth", async ({ extension }) => {
  await extension.seedOnboarded();
  const page = await extension.openSurface('popup');
  const [welcome, response] = await page.evaluate(askHealth, 'popup');
  expect(welcome).toMatchObject({ frame: 'welcome', protocol: { major: 1, minor: 0 }, status: 'ready' });
  expect(welcome.extensionVersion).toBe(await page.evaluate(() => chrome.runtime.getManifest().version));
  expect(response).toMatchObject({
    frame: 'response',
    requestId: 'r1',
    result: { kind: 'ready', data: { coordinatorId: welcome.coordinatorId, connections: 1, handshakes: 1 } },
  });
  expect(await extension.uncaught()).toEqual([]);
});

/**
 * In the page: open the port, say hello as `surface`, and resolve with the welcome and how
 * long it took from the hello, in ms, then close the port
 */
function timedWelcome(surface) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'ntn-rpc' });
    port.onDisconnect.addListener(() => {
      reject(new Error(`The port closed: ${chrome.runtime.lastError ? chrome.runtime.lastError.message : 'by the worker'}`));
    });
    let said = 0;
    port.onMessage.addListener(text => {
      const tookMs = performance.now() - said;
      port.disconnect();
      resolve({ welcome: JSON.parse(text), tookMs });
    });
    said = performance.now();
    port.postMessage(JSON.stringify({
      frame: 'hello',
      protocol: { major: 1, minor: 0 },
      extensionVersion: chrome.runtime.getManifest().version,
      surface,
      sessionId: `e2e-${surface}-${Date.now()}`,
    }));
  });
}

test("a hello that wakes a worker Chrome stopped is welcomed once the coordinator's start it sets off is done, as ready (#35)", async ({ extension }, testInfo) => {
  await extension.seedOnboarded();
  const blank = await extension.context.newPage();
  const cdp = await extension.context.newCDPSession(blank);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await blank.close();

  // The offscreen page reads and writes nothing, so the hello is what wakes the worker, and
  // its coordinator is idle until the hello starts it
  const page = await extension.context.newPage();
  await page.goto(extension.url('offscreen.html'));
  const cold = await page.evaluate(timedWelcome, 'offscreen');
  // The next hello finds it started
  const warm = await page.evaluate(timedWelcome, 'offscreen');
  await page.close();
  // How long each welcome took from its hello, and what it said
  for (const [type, { welcome, tookMs }] of [['cold-welcome', cold], ['warm-welcome', warm]]) {
    testInfo.annotations.push({ type, description: `${Math.round(tookMs)} ms, ${[welcome.status, welcome.reason].filter(Boolean).join(' ')}` });
  }
  expect(cold.welcome).toMatchObject({ frame: 'welcome', protocol: { major: 1, minor: 0 }, status: 'ready' });
  expect(cold.welcome.reason).toBeUndefined();
  expect(warm.welcome).toMatchObject({ frame: 'welcome', status: 'ready', coordinatorId: cold.welcome.coordinatorId });
  expect(await extension.uncaught()).toEqual([]);
});
