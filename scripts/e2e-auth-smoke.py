# Browser smoke test for sign-in. Needs: pip install playwright && playwright install chromium
# Run against a fresh server on :10000 (BETTER_AUTH_URL=http://localhost:10000), then: python3 scripts/e2e-auth-smoke.py
import os; os.makedirs("/tmp/smoke-out", exist_ok=True)
import json, sys
from playwright.sync_api import sync_playwright
OUT="/tmp/smoke-out"
results=[]; errors=[]
def check(name, ok, detail=""):
    results.append((name, ok, detail)); print(("PASS" if ok else "FAIL"), name, detail)

with sync_playwright() as p:
    b=p.chromium.launch()
    for origin in ["http://localhost:10000","http://127.0.0.1:10000"]:
        ctx=b.new_context(viewport={"width":1280,"height":800}); pg=ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(m.text) if m.type=="error" and "403" not in m.text and "401" not in m.text else None)
        navs=[]; pg.on("framenavigated", lambda f: navs.append(f.url) if f==pg.main_frame else None)
        tag=origin.split("//")[1].split(":")[0]
        pg.goto(origin+"/"); pg.wait_for_url("**/login", timeout=15000)
        check(f"[{tag}] unauthenticated / redirects to /login", "/login" in pg.url, pg.url)
        pg.wait_for_selector("#email", timeout=10000)
        check(f"[{tag}] login form renders", pg.locator("#email").is_visible() and pg.locator("#password").is_visible())
        if tag=="localhost": pg.screenshot(path=f"{OUT}/1-login.png")
        # sign up via UI
        pg.get_by_text("Need an account? Create one").click()
        pg.fill("#name","Smoke Tester"); pg.fill("#email",f"smoke-{tag}@example.com"); pg.fill("#password","password1234")
        pg.get_by_role("button",name="Create account").click()
        navs.clear()
        pg.wait_for_url(lambda u: "/login" not in u, timeout=15000); pg.wait_for_timeout(1500)
        check(f"[{tag}] sign-up has no /login bounce", not any("/login" in u for u in navs[1:]), str(navs))
        check(f"[{tag}] UI sign-up lands in app", "/login" not in pg.url, pg.url)
        cookies={c["name"] for c in ctx.cookies()}
        check(f"[{tag}] session cookie set", "__Host-grok-auth.session_token" in cookies)
        if tag=="localhost": pg.screenshot(path=f"{OUT}/2-app-after-signup.png")
        # reload keeps session
        pg.reload(); pg.wait_for_timeout(2500)
        check(f"[{tag}] session survives reload", "/login" not in pg.url, pg.url)
        # nav routes
        for r in ["minutes","library","ask","sources"]:
            resp=pg.goto(f"{origin}/{r}", wait_until="networkidle")
            check(f"[{tag}] /{r} loads authed", resp.status<400 and "/login" not in pg.url, f"{resp.status} {pg.url}")
        if tag=="localhost": pg.goto(origin+"/minutes",wait_until="networkidle"); pg.screenshot(path=f"{OUT}/3-minutes.png")
        # sign out + sign back in via UI
        api=ctx.request.post(origin+"/api/auth/sign-out",headers={"origin":origin,"content-type":"application/json"},data="{}")
        pg.goto(origin+"/login"); pg.wait_for_selector("#email", timeout=10000)
        check(f"[{tag}] sign-out ok", api.status==200, str(api.status))
        pg.fill("#email",f"smoke-{tag}@example.com"); pg.fill("#password","wrongpass123")
        pg.get_by_role("button",name="Sign in").click(); pg.wait_for_timeout(1500)
        check(f"[{tag}] wrong password shows error", pg.get_by_text("Invalid email or password").is_visible())
        if tag=="localhost": pg.screenshot(path=f"{OUT}/4-wrong-password.png")
        pg.fill("#password","password1234"); pg.get_by_role("button",name="Sign in").click()
        pg.wait_for_url(lambda u: "/login" not in u, timeout=15000)
        check(f"[{tag}] UI sign-in works", "/login" not in pg.url, pg.url)
        ctx.close()
    # mobile
    ctx=b.new_context(viewport={"width":390,"height":844}); pg=ctx.new_page()
    pg.goto("http://localhost:10000/login"); pg.wait_for_selector("#email", timeout=10000); pg.screenshot(path=f"{OUT}/5-login-mobile.png")
    check("mobile login renders", pg.locator("#email").is_visible())
    b.close()
bad=[e for e in errors if "favicon" not in e]
check("no console/page errors", not bad, "; ".join(bad[:3])[:200])
json.dump([{"name":n,"ok":o,"detail":d} for n,o,d in results], open(f"{OUT}/results.json","w"), indent=1)
print(f"\n{sum(o for _,o,_ in results)}/{len(results)} passed")
sys.exit(0 if all(o for _,o,_ in results) else 1)
