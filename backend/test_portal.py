"""Contractor portal: scoping, derived blocking, deny/approve, override note. Run from backend/."""
import os, sys
os.environ["JENGA_OFFLINE"]="1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fastapi.testclient import TestClient
import main
with TestClient(main.app) as c:
    ov=c.get("/api/portal?company_id=ellis-civil").json()
    assert {o["id"] for o in ov["owners"]}=={"halton-transit","lakeshore-water"}, ov["owners"]
    assert {p["id"] for p in ov["projects"]}=={"eglinton-west-station","ossington-relief-tunnel"}
    g=c.get("/api/graph?project_id=ossington-relief-tunnel").json()
    st={t["id"]:t["state"] for t in g["tasks"]}
    assert st["ossington-relief-tunnel:T-212"]=="blocked"
    tid="ossington-relief-tunnel:T-211"
    r=c.post(f"/api/tasks/{tid}/verify",json={"report_text":"Drop shaft sinking complete and inspected."}); assert r.status_code==200,r.text
    assert c.post(f"/api/tasks/{tid}/verify",json={"report_text":"again"}).status_code==409
    q=c.get("/api/portal/owners/lakeshore-water/queue").json(); assert len(q)==1
    assert c.get("/api/portal/owners/halton-transit/queue").json()==[]
    rid=q[0]["report"]["id"]
    assert q[0]["impact"]["rework_days"]>=2 and q[0]["impact"]["affected"][0]["id"]==tid, q[0]["impact"]
    cv=c.get("/api/projects/ossington-relief-tunnel/reports?view=contractor").json(); assert cv[0]["verdict"] is None
    assert c.post(f"/api/reports/{rid}/decision",json={"decision":"deny"}).status_code==422
    d=c.post(f"/api/reports/{rid}/decision",json={"decision":"deny","note":"Need photo"}).json()
    assert {t["id"]:t["state"] for t in d["tasks"]}[tid]=="active"
    # the denial keeps the prediction; the contractor sees only the reduced copy
    assert d["report"]["impact"]["rework_days"]==q[0]["impact"]["rework_days"]
    cv=c.get("/api/projects/ossington-relief-tunnel/reports?view=contractor").json()[0]
    assert cv["verdict"] is None and set(cv["impact"])=={"rework_days","predicted_finish_date","project_slipped_days"}, cv
    ov=c.get("/api/projects/ossington-relief-tunnel/reports?view=owner").json()[0]
    assert ov["impact"]["affected"], ov
    b=next(t for t in c.get("/api/graph?project_id=ossington-relief-tunnel").json()["tasks"] if t["id"].endswith("T-212"))
    assert b["state"]=="blocked" and b["blocked_by"]==[tid], b
    r=c.post(f"/api/tasks/{tid}/verify",json={"report_text":"Drop shaft sinking complete, photo attached."}); assert r.status_code==200
    rid=c.get("/api/portal/owners/lakeshore-water/queue").json()[0]["report"]["id"]
    body={"decision":"approve"}
    r=c.post(f"/api/reports/{rid}/decision",json=body)
    if r.status_code==422: r=c.post(f"/api/reports/{rid}/decision",json={**body,"note":"Verified on site"})
    assert r.status_code==200,r.text
    st={t["id"]:t["state"] for t in r.json()["tasks"]}
    print(st[tid], st["ossington-relief-tunnel:T-212"], r.json()["report"]["ai_override"])
    assert st[tid]=="verified" and st["ossington-relief-tunnel:T-212"]=="active"
    # other projects untouched; reset scoped
    assert {t["id"]:t["state"] for t in c.get("/api/graph").json()["tasks"]}["P-107"]=="active"
    c.post("/api/reset?project_id=ossington-relief-tunnel")
    assert {t["id"]:t["state"] for t in c.get("/api/graph?project_id=ossington-relief-tunnel").json()["tasks"]}[tid]=="active"
    assert len(c.get("/api/graph").json()["tasks"])==16
    print("All portal checks passed")
