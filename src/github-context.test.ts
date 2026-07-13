import assert from "node:assert/strict";
import test from "node:test";
import { countExplicitAcceptanceCriteria, listExplicitAcceptanceCriteria } from "./github.js";

test("explicit acceptance sections, checkboxes, and AC labels form a deterministic floor", () => {
  const body = [
    "## 변경사항",
    "- 구현 세부사항은 인수조건으로 세지 않는다.",
    "## 인수조건",
    "- 저장 후 값이 유지된다.",
    "2. 다시 열면 복원된다.",
    "## 작업",
    "- [ ] 일반 경로에서 크래시가 없다.",
    "AC-4: 개인정보가 로그에 남지 않는다.",
    "- [x] 저장 후 값이 유지된다.",
  ].join("\n");
  assert.equal(countExplicitAcceptanceCriteria(body), 4);
  assert.equal(countExplicitAcceptanceCriteria("## 변경사항\n- 내부 함수 이름 변경"), 0);
});

test("requirements headings and wrapped constraints remain explicit acceptance criteria", () => {
  const body = [
    "## 요구사항",
    "- 저장한 이름이 다시 열어도 유지된다.",
    "  단, 사용자별로 데이터가 분리되어야 한다.",
    "  - 로그아웃하면 세션이 폐기된다.",
  ].join("\n");
  assert.deepEqual(listExplicitAcceptanceCriteria(body), [
    "저장한 이름이 다시 열어도 유지된다. 단, 사용자별로 데이터가 분리되어야 한다.",
    "로그아웃하면 세션이 폐기된다.",
  ]);
  assert.equal(countExplicitAcceptanceCriteria("## Requirements\n- Data persists.\n- Sessions expire."), 2);
});
