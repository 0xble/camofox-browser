# Native window binding verification

## Root cause

Baseline `0b632221d0b85d75b912dcbcac24ed71805b78a6` failed both native
handoff cases with `native window identity could not be bound` on a disposable
copy of the signed 158.0.1-beta.41 app. Absolute geometry compared two different
coordinate spaces. The session was locked (`CGSSessionScreenIsLocked: true`),
with `loginwindow` frontmost. WindowServer's locked-desktop transform affected
CGWindow visual bounds, not AppKit or WebExtension requested coordinates.

A **plain NSWindow**, with no Camoufox, fingerprint, Juggler, or web content,
reproduced the same scale: AppKit frame 1280x900 yielded CGWindow 1153x811.
AppKit x = 40, 140, 240, 40 produced native x = 138, 228, 318, 138.
The measured displacement scale was exactly 0.9, stable across these samples
and repeated browser launches. Main NSScreen was 2048x1152 with backingScale=2;
DeskPad was 1280x960 with backingScale=1. The main-display x offset agrees with
a 0.9 transform around the display center (102.4 points, then integer bounds).
Pixel rounding accounts for dimensions one point larger than exact 0.9x.
This is not a CSS/devicePixelRatio conversion. Native browser output below has
devicePixelRatio=1 and the same 1280x900 -> 1153x811 mismatch after reopen.

Do not hardcode 0.9: it is an observed desktop-state transform, not a guaranteed
engine or platform constant. An exact-target out-and-back motion challenge
binds the stable PID-owned CGWindow number without assuming its scale/origin.

### Independent AppKit probe

Run this source with `osascript -l JavaScript` from a scratch file. It creates,
moves, inspects and terminates only its own disposable window; it does not change
the locked session or other apps. Capture the selected window by number, not title.

```js
ObjC.import('AppKit');ObjC.import('CoreGraphics');ObjC.bindFunction('CGWindowListCopyWindowInfo',['id',['uint32','uint32']]);
const app=$.NSApplication.sharedApplication;app.setActivationPolicy(0);
const win=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(40,212,1280,900),15,2,false);
win.title='Disposable Window Units Probe';win.orderFrontRegardless;app.activateIgnoringOtherApps(true);
for(const x of [40,140,240,40]){win.setFrameDisplay($.NSMakeRect(x,190,1280,900),true);$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.3));console.log(JSON.stringify({frame:win.frame,number:win.windowNumber,windows:(ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(17,0))||[]).filter(w=>w.kCGWindowNumber===Number(win.windowNumber))}));}
app.terminate(null);
```

## Signed beta.41 native harness

```sh
TMPDIR=/path/to/scratch \
CAMOFOX_NATIVE_TEST_APP=/Applications/Camoufox-beta41-test.app \
node --test tests/native/mainDisplayHandoff.mjs
```

The harness copies the app and verifies `codesign --verify --deep --strict`
before launching. It uses the shared production launch helper, random Camoufox
fingerprint, en-US locale and America/Los_Angeles timezone (matching the live
process's two non-secret identity settings). The server and live profiles are
never used. Main/off-main starts each perform two show/release cycles.
Assertions cover exact bound-number main placement, per-PID frontmost ordering,
unchanged PID, target/sibling unsaved inputs, sibling preservation and independent
AppKit `hidden:true` after every release.

Global activation was **not** available while the Mac was locked. The API
truthfully returned `focused:false`; native `frontmost:true` means the exact
window is first among its own PID's windows, not above loginwindow. No unlock,
permission grant or live service change was attempted.

Captured output:

```text
{"launch":{"locale":"en-US","timezoneId":"America/Los_Angeles","fingerprint":{"screen.width":1440,"screen.height":900,"screen.availWidth":1440,"screen.availHeight":744,"window.outerWidth":1440,"window.outerHeight":744,"screen.colorDepth":30,"screen.pixelDepth":30,"window.screenX":0,"window.screenY":0,"window.history.length":2,"locale:region":"US","locale:language":"en","locale:script":"Latn"}}}
{"pid":12191,"attempt":0,"shown":{"visible":true,"focused":false},"nativeProof":{"parked":false,"onMain":true,"frontmost":true,"bounds":{"left":40,"top":40,"width":1280,"height":900,"focused":true,"state":"normal"},"number":33102,"actual":{"number":33102,"left":138,"top":93,"width":1297,"height":671}},"main":{"left":0,"top":0,"width":2048,"height":1152},"windows":[{"number":33102,"left":138,"top":93,"width":1297,"height":671},{"number":33103,"left":145,"top":124,"width":1297,"height":670},{"number":33101,"left":106,"top":84,"width":1296,"height":671}],"css":{"outerWidth":1440,"outerHeight":744,"screenX":0,"screenY":0,"devicePixelRatio":1},"offMainFixture":false}
{"pid":12191,"attempt":0,"released":{"hidden":true,"active":false,"activated":false}}
{"pid":12191,"attempt":1,"shown":{"visible":true,"focused":false},"nativeProof":{"parked":false,"onMain":true,"frontmost":true,"bounds":{"left":40,"top":40,"width":1280,"height":900,"focused":true,"state":"normal"},"number":33102,"actual":{"number":33102,"left":138,"top":93,"width":1153,"height":811}},"main":{"left":0,"top":0,"width":2048,"height":1152},"windows":[{"number":33102,"left":138,"top":93,"width":1153,"height":811},{"number":33103,"left":145,"top":124,"width":1297,"height":670},{"number":33101,"left":106,"top":84,"width":1296,"height":671}],"css":{"outerWidth":1280,"outerHeight":900,"screenX":0,"screenY":0,"devicePixelRatio":1},"offMainFixture":false}
{"pid":12191,"attempt":1,"released":{"hidden":true,"active":false,"activated":false}}
✔ app-hidden handoff preserves inputs and PID (start off-main=false) (28603.621833ms)
{"launch":{"locale":"en-US","timezoneId":"America/Los_Angeles","fingerprint":{"screen.availTop":30,"screen.width":3440,"screen.height":1440,"screen.availWidth":3440,"screen.availHeight":1410,"window.outerWidth":3440,"window.outerHeight":1410,"screen.colorDepth":30,"screen.pixelDepth":30,"window.screenX":0,"window.screenY":0,"window.history.length":3,"locale:region":"US","locale:language":"en","locale:script":"Latn"}}}
{"pid":18527,"attempt":0,"shown":{"visible":true,"focused":false},"nativeProof":{"parked":false,"onMain":true,"frontmost":true,"bounds":{"left":40,"top":40,"width":1280,"height":900,"focused":true,"state":"normal"},"number":33109,"actual":{"number":33109,"left":138,"top":84,"width":3097,"height":1011}},"main":{"left":0,"top":0,"width":2048,"height":1152},"windows":[{"number":33109,"left":138,"top":84,"width":3097,"height":1011},{"number":33110,"left":120,"top":84,"width":3097,"height":1011},{"number":33108,"left":120,"top":84,"width":3097,"height":1011}],"css":{"outerWidth":3440,"outerHeight":1122,"screenX":0,"screenY":0,"devicePixelRatio":1},"offMainFixture":true}
{"pid":18527,"attempt":0,"released":{"hidden":true,"active":false,"activated":false}}
{"pid":18527,"attempt":1,"shown":{"visible":true,"focused":false},"nativeProof":{"parked":false,"onMain":true,"frontmost":true,"bounds":{"left":40,"top":40,"width":1280,"height":900,"focused":true,"state":"normal"},"number":33109,"actual":{"number":33109,"left":138,"top":93,"width":1153,"height":811}},"main":{"left":0,"top":0,"width":2048,"height":1152},"windows":[{"number":33109,"left":138,"top":93,"width":1153,"height":811},{"number":33110,"left":120,"top":84,"width":3097,"height":1011},{"number":33108,"left":102,"top":84,"width":1844,"height":1011}],"css":{"outerWidth":1280,"outerHeight":900,"screenX":0,"screenY":0,"devicePixelRatio":1},"offMainFixture":true}
{"pid":18527,"attempt":1,"released":{"hidden":true,"active":false,"activated":false}}
✔ app-hidden handoff preserves inputs and PID (start off-main=true) (29677.098667ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 58668.161917
```

## Local verification and review

- `npm ci`: passed.
- Full Jest unit command (`node --experimental-vm-modules node_modules/.bin/jest --testPathPatterns=tests/unit --forceExit`): 112 suites passed; 1550 tests passed, 2 skipped.
- Focused native binding/addon suites: 81 tests passed.
- `node --test tests/unit/sharedIdentityHidden.test.js`: 45 passed.
- Native signed-app harness above: 2 passed, 0 failed.
- Independent read-only review approved the final production/test candidate after
  resolving sibling-scaling, bounded-readback, cancellation and transient-retry
  findings. Review is not an unlocked-desktop focus claim.

No deployment or live service/profile mutation is included.
