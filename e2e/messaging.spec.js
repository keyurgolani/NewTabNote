/**
 * The worker's router (#13 slice 2), in Chrome: an extension page that opens the ntn-rpc
 * port is welcomed, as the surface its sender is, and answered system.messagingHealth. No
 * page opens the port on its own until #35 moves a client to it, so this one opens it by
 * hand and speaks the frames a client would.
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
