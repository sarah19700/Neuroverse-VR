// ── WEBXR PATCH ─────────────────────────────────────────────────────────────
// Append this code at the very bottom of main.js (inside the main() function,
// after the frame() call but before the file-loading while loop).
//
// It hijacks the render loop when VR is active, feeding the headset pose
// into the existing viewMatrix + projectionMatrix uniforms.
// ────────────────────────────────────────────────────────────────────────────

(async function patchWebXR() {
    const vrBtn   = document.getElementById("vr-btn");
    const vrToast = document.getElementById("vr-toast");

    // ── 1. Check support ──────────────────────────────────────────────────────
    const supported = navigator.xr
        ? await navigator.xr.isSessionSupported("immersive-vr").catch(() => false)
        : false;

    if (!supported) {
        if (vrBtn) vrBtn.classList.add("unavailable");
    }

    function showToast(msg) {
        if (!vrToast) return;
        vrToast.textContent = msg;
        vrToast.classList.add("visible");
        setTimeout(() => vrToast.classList.remove("visible"), 3500);
    }

    // ── 2. XR session state ───────────────────────────────────────────────────
    let xrSession    = null;
    let xrRefSpace   = null;
    let xrActive     = false;
    let xrRafHandle  = null;

    // ── 3. Matrix helpers (same math already in main.js, redeclared locally) ──
    function mat4FromXRPose(p) {
        // XRRigidTransform gives us a Float32Array column-major 4x4
        return Array.from(p.matrix);
    }

    function invertXRView(m) {
        // The XR view matrix is already a view matrix (world→camera).
        // We need the same format main.js uses, which is also world→camera.
        // So we return it directly as a flat array.
        return Array.from(m);
    }

    function buildProjection(fov, near, far) {
        // fov is an XRFieldOfView: { upDegrees, downDegrees, leftDegrees, rightDegrees }
        const up    = Math.tan(fov.upDegrees    * Math.PI / 180);
        const down  = Math.tan(fov.downDegrees  * Math.PI / 180);
        const left  = Math.tan(fov.leftDegrees  * Math.PI / 180);
        const right = Math.tan(fov.rightDegrees * Math.PI / 180);
        const w = left + right;
        const h = up   + down;
        return [
            2 / w,            0,                  0,                          0,
            0,                2 / h,              0,                          0,
            (right - left)/w, (up - down)/h,     -(far + near) / (far - near), -1,
            0,                0,                 -(2 * far * near) / (far - near), 0,
        ];
    }

    // ── 4. XR frame loop ──────────────────────────────────────────────────────
    function xrFrame(time, frame) {
        if (!xrActive) return;

        xrRafHandle = xrSession.requestAnimationFrame(xrFrame);

        const pose = frame.getViewerPose(xrRefSpace);
        if (!pose) return;

        // We'll render once per eye using the existing WebGL program.
        // The canvas is split left/right (stereo).
        const layer  = xrSession.renderState.baseLayer;
        const fb     = layer.framebuffer;

        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);

        for (const view of pose.views) {
            const vp = layer.getViewport(view);
            gl.viewport(vp.x, vp.y, vp.width, vp.height);

            // Feed view matrix into main.js uniform
            const xrViewMat = Array.from(view.transform.inverse.matrix);
            gl.uniformMatrix4fv(u_view, false, xrViewMat);

            // Build projection from XR fov
            const proj = buildProjection(view.fieldOfView, 0.2, 200);
            gl.uniformMatrix4fv(u_projection, false, proj);

            // Update focal uniforms to approximate XR fov
            const focalX = (proj[0] * vp.width)  / 2;
            const focalY = (proj[5] * vp.height) / 2;
            gl.uniform2fv(u_focal,    new Float32Array([focalX, focalY]));
            gl.uniform2fv(u_viewport, new Float32Array([vp.width, vp.height]));

            // Draw splats
            if (vertexCount > 0) {
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
            }

            // Update depth sort with left eye view-proj (once per frame is enough)
            if (view === pose.views[0]) {
                const viewProj = multiply4(proj, xrViewMat);
                worker.postMessage({ view: viewProj });
            }
        }
    }

    // ── 5. Enter / Exit VR ───────────────────────────────────────────────────
    async function enterVR() {
        if (!supported) {
            showToast("VR not available. Use a Meta Quest or WebXR headset.");
            return;
        }
        if (xrSession) {
            await xrSession.end();
            return;
        }

        try {
            xrSession = await navigator.xr.requestSession("immersive-vr", {
                requiredFeatures: ["local-floor"],
                optionalFeatures: ["bounded-floor", "hand-tracking"],
            });
        } catch (e) {
            showToast("Could not start VR session. Try again.");
            console.error(e);
            return;
        }

        // Bind the existing WebGL context to XR
        await gl.makeXRCompatible();
        const layer = new XRWebGLLayer(xrSession, gl);
        xrSession.updateRenderState({ baseLayer: layer });

        xrRefSpace = await xrSession.requestReferenceSpace("local-floor")
            .catch(() => xrSession.requestReferenceSpace("local"));

        xrActive = true;
        carousel = false; // stop the auto-carousel

        if (vrBtn) vrBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8z"/>
                <circle cx="8.5" cy="12" r="1.5"/><circle cx="15.5" cy="12" r="1.5"/>
                <path d="M11 12h2"/>
            </svg> Exit VR`;

        xrSession.addEventListener("end", () => {
            xrActive    = false;
            xrSession   = null;
            xrRefSpace  = null;
            // Restore normal canvas size
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            resize();
            if (vrBtn) vrBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M2 8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8z"/>
                    <circle cx="8.5" cy="12" r="1.5"/><circle cx="15.5" cy="12" r="1.5"/>
                    <path d="M11 12h2"/>
                </svg> Enter VR`;
        });

        xrRafHandle = xrSession.requestAnimationFrame(xrFrame);
    }

    // Expose to the button onclick in index.html
    window.enterVR = enterVR;

})();