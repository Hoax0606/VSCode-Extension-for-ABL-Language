import * as vscode from 'vscode';

/**
 * Semantic token legend
 * - ablMap   : Map 계열 (@Map.Get / @Map.Set) + 그 호출에 속한 모든 @
 * - ablFunc  : 일반 함수 (@Replace, @Get, @Pos 등) + 그 호출에 속한 모든 @
 * - ablLogic : If 조건식 내 And/Or, 비교연산자
 */
const legend = new vscode.SemanticTokensLegend(['ablMap', 'ablFunc', 'ablLogic'], []);

type CtxKind = 'ablMap' | 'ablFunc';
type Frame = { kind: CtxKind; depth: number };
type TokenKind = 'ablMap' | 'ablFunc' | 'ablLogic';

/** tmLanguage 색(예: support.function.writer)을 덮어쓰지 않도록 Semantic에서 제외할 키워드 */
const WRITER_KEYWORDS = new Set([
  'Data',
  'AddLine',
  'AddLinePrespace',
  'InsertLine',
  'InsertLinePrespace'
]);

/* ============================================================
 * Utils
 * ============================================================ */
function isIdentChar(ch: string) {
  return /[A-Za-z0-9_]/.test(ch);
}

function isAttachPunct(ch: string) {
  return ch === '(' || ch === ')' || ch === ',' || ch === ']' || ch === '|' || ch === "'" || ch === '"' || ch === '!';
}

function isWordBoundary(text: string, start: number, length: number) {
  const before = start - 1 >= 0 ? text[start - 1] : '';
  const after = start + length < text.length ? text[start + length] : '';
  return !isIdentChar(before) && !isIdentChar(after);
}

function pushToken(
  builder: vscode.SemanticTokensBuilder,
  doc: vscode.TextDocument,
  offset: number,
  length: number,
  kind: TokenKind
) {
  const pos = doc.positionAt(offset);
  builder.push(pos.line, pos.character, length, legend.tokenTypes.indexOf(kind), 0);
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/** ABL 주석: 라인 맨 앞(공백 허용)에서 시작하는 #만 주석 */
function isCommentLine(text: string) {
  return /^[ \t]*#/.test(text);
}

/**
 * 문자열 안(따옴표 내부)은 And/Or/비교연산자 분리의 대상이 아니어야 함.
 * - '' / ''' 케이스를 포함해, 문자열/escape를 "완전 파싱"하지 않고 보수적으로 split 한다.
 */
function splitByAndOrTopLevel(s: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  let inQ = false;

  const isIdent = (c: string) => /[A-Za-z0-9_]/.test(c);

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (ch === "'") {
      const next = s[i + 1];

      if (inQ) {
        if (next === "'") { i++; continue; } // '' inside string => escape
        inQ = false;
        continue;
      } else {
        if (next === "'") { i++; continue; } // '' outside string => empty literal
        inQ = true;
        continue;
      }
    }
    if (inQ) continue;

    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (depth !== 0) continue;

    if (s.startsWith('And', i) && !isIdent(s[i - 1] ?? '') && !isIdent(s[i + 3] ?? '')) {
      out.push(s.slice(start, i));
      start = i + 3;
      i += 2;
      continue;
    }
    if (s.startsWith('Or', i) && !isIdent(s[i - 1] ?? '') && !isIdent(s[i + 2] ?? '')) {
      out.push(s.slice(start, i));
      start = i + 2;
      i += 1;
      continue;
    }
  }

  out.push(s.slice(start));
  return out;
}

function splitCompareTopLevel(expr: string): { left: string; op: string; right: string } | null {
  const ops = ['<>', '>=', '<=', '=', '>', '<'] as const;
  let depth = 0;
  let inQ = false;

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];

    if (ch === "'") {
      const next = expr[i + 1];

      if (inQ) {
        if (next === "'") { i++; continue; } // '' inside string => escape
        inQ = false;
        continue;
      } else {
        if (next === "'") { i++; continue; } // '' outside string => empty literal
        inQ = true;
        continue;
      }
    }
    if (inQ) continue;

    if (ch === '(') { depth++; continue; }
    if (ch === ')') { if (depth > 0) depth--; continue; }
    if (depth !== 0) continue;

    for (const op of ops) {
      if (expr.startsWith(op, i)) {
        return {
          left: expr.slice(0, i),
          op,
          right: expr.slice(i + op.length)
        };
      }
    }
  }

  return null;
}

/* ============================================================
 * Completion (IntelliSense)
 *  - '@' 입력 후 선택하면 '@'가 중복되는 문제 해결
 *  - '@Map.' / '^Data.' / '^Data.Item[].' 컨텍스트 지원
 *  - 'Item[].' 선택하면 다음 추천창(Name! 등) 자동 트리거
 * ============================================================ */

function md(s: string) {
  const m = new vscode.MarkdownString(s.trim());
  m.supportHtml = false;
  m.isTrusted = true;
  return m;
}

function ciSnippet(label: string, snippet: string, detail?: string, doc?: string) {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  item.insertText = new vscode.SnippetString(snippet);
  item.detail = detail ?? 'ABL';
  if (doc) item.documentation = md(doc);
  return item;
}

function ciKeyword(label: string, insert?: string, detail?: string, doc?: string) {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Keyword);
  item.insertText = insert ?? label;
  item.detail = detail ?? 'ABL';
  if (doc) item.documentation = md(doc);
  return item;
}

function ciProperty(label: string, insert?: string, detail?: string, doc?: string) {
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
  item.insertText = insert ?? label;
  item.detail = detail ?? 'ABL';
  if (doc) item.documentation = md(doc);
  return item;
}

// ---- prefix 제거 버전(핵심: '@' 치고 선택하면 '@' 중복 방지) ----
function withoutLeadingAt(s: string) {
  return s.startsWith('@') ? s.slice(1) : s;
}
function withoutLeadingCaret(s: string) {
  return s.startsWith('^') ? s.slice(1) : s;
}

function cloneWithoutPrefix(items: vscode.CompletionItem[], stripFn: (s: string) => string) {
  return items.map(it => {
    const c = new vscode.CompletionItem(it.label, it.kind);
    c.detail = it.detail;
    c.documentation = it.documentation;
    c.sortText = it.sortText;
    c.filterText = it.filterText;
    c.preselect = it.preselect;

    c.command = it.command; // ✅ 이거 추가 (중요)

    const ins = it.insertText;
    if (ins instanceof vscode.SnippetString) {
      c.insertText = new vscode.SnippetString(stripFn(ins.value));
    } else if (typeof ins === 'string') {
      c.insertText = stripFn(ins);
    } else {
      c.insertText = stripFn(String(it.label));
    }
    return c;
  });
}

/** 도트 컨텍스트에서는 '.' 뒤에 들어갈 suffix만 삽입해야 함(중복 방지) */
function makeDotSuffixItems(
  prefixForDoc: string,
  suffixes: string[],
  detail: string,
  docBuilder?: (full: string) => string,
  autoTriggerSuggest?: boolean
) {
  return suffixes.map(sfx => {
    // label은 "짧게"
    const label = sfx; // 예: Name!, Item[]., Count!
    const insert = sfx; // '.' 뒤에 붙을 부분만
    const full = prefixForDoc + sfx;

    const item = ciProperty(label, insert, detail, docBuilder ? docBuilder(full) : `\`\`\`abl\n${full}\n\`\`\``);

    // Item[]. 처럼 "계속 이어지는 것"은 선택 직후 자동 추천 뜨게
    if (autoTriggerSuggest) {
      item.command = {
        title: 'Trigger Suggest',
        command: 'editor.action.triggerSuggest'
      };
    }
    return item;
  });
}

/* --------------------------
 * @ 전체 목록 (Ctrl+Space or @ 트리거)
 * -------------------------- */
const COMPLETIONS_AT: vscode.CompletionItem[] = [
  // Map
  ciSnippet('@Map.Set@(@,@)','@Map.Set@(${1:key}@,${2:value}@)','Map',
    `
**Map에 값 저장**

- 인자1: Key
- 인자2: Value

\`\`\`abl
# Company_Name 이라는 Key 값에 ValueAndForce라는 값 저장
@Map.Set@(Company_Name@,ValueAndForce@)
\`\`\`
`
  ),

  ciSnippet('@Map.Get@(@)','@Map.Get@(${1:value}@)','Map',
    `
**Map에 저장된 Key 값 가져오기**

- 인자1: Key

\`\`\`abl
# ValueAndForce 값 가져요가
@Map.Get@(Company_Name@)
\`\`\`
`
  ),
  ciSnippet('@Map.Clear()','@Map.Clear(${1:key})','Map',
    `
**Map 값 초기화**
예:
\`\`\`abl
# 저장된 모든 Map 값 삭제
@Map.Clear()

# Company_Name 이라는 Key 값 삭제
@Map.Clear(Company_Name)

# Company_ 가 Key인 모든 Map 값 삭제 (구분자 : _*)
@Map.Clear(Company__*)
\`\`\`
`
  ),

  // Control
  ciSnippet('@If ... @Then ... @End If','@If ${1:condition} @Then\n\t${2:statememt}\n@End If','Control',
    `
**If 조건문**

\`\`\`abl
@If condition @Then
    statememt
@End If
\`\`\`
`
  ),

  ciSnippet('@Else If ... @Then','@Else If ${1:condition} @Then','Control',
    `
**Else If 조건문**

\`\`\`abl
@Else If condition @Then
    statement
\`\`\``
  ),
  ciKeyword('@Else', '@Else', 'Control', `\`\`\`abl\n@Else\n\`\`\``),
  ciKeyword('@End If', '@End If', 'Control', `\`\`\`abl\n@End If\n\`\`\``),
  ciSnippet('@For ... @End For','@For ${1:condition}\n\t${2:statememt}\n@End For','Loop',
    `
**For 반복문**

\`\`\`abl
@For condition
  statement
@End For\`\`\``
  ),
  ciKeyword('@End For', '@End For', 'Loop', `\`\`\`abl\n@End For\n\`\`\``),
  ciSnippet('@Break', '@Break', 'Control', 
  `
**For 문을 즉시 빠져나오는 제어문**

\`\`\`abl
@Break
\`\`\`
  `
),
  ciSnippet('@Continue', '@Continue', 'Control', 
    `
**반복문에서 나머지 코드 건너뛰고 다음 반복으로 즉시 넘어가는 제어문**

\`\`\`abl
@Continue
\`\`\`
    `
  ),

  // Functions
  ciSnippet('@UpperCase@(@)', '@UpperCase@(${1:string}@)', 'Function',
    `
**대문자로 변환**

- 인자1 : 문자열

\`\`\`abl
#aaaa -> AAAA
@UpperCase@(aaaa@)
\`\`\`
    `
  ),
  ciSnippet('@LoweCase@(@)', '@LoweCase@(${1:string}@)', 'Function',
    `
**소문자로 변환**

- 인자1 : 문자열

\`\`\`abl
#AAAA -> aaaa
@UpperCase@(AAAA@)
\`\`\`
    `
  ),
  ciSnippet('@SubString@(@,@,@)', '@SubString@(${1:string}@,${2:position}@,${3:length}@)', 'Function',
    `
**문자열의 시작 위치부터 길이 만큼 출력**

- 인자1 : 문자열
- 인자2 : 시작 위치
- 인자3 : 길이
\`\`\`abl
#abcdefg -> bcd
@SubString@(abcdefg@,2@,3@)
\`\`\`
    `
  ),
  ciSnippet('@Replace@(@,@,@)', '@Replace@(${1:string}@,${2:before}@,${3:after}@)', 'Function',
    `
**문자 대체**

- 인자1 : 문자열
- 인자2 : 대체할 문자열
- 인자3 : 치환 문자열

\`\`\`abl
#abcdefg -> a123efg
@Replace@(abcdefg@,bcd@,123@)
\`\`\`
    `
  ),
  ciSnippet('@Length@(@)', '@Length@(${1:string}@)', 'Function',
    `
**문자열 길이**

- 인자1 : 문자열

\`\`\`abl
#なるほうど -> 5
@Length@(なるほうど@)
\`\`\`
    `
  ),
  ciSnippet('@LengthB@(@)', '@LengthB@(${1:string}@)', 'Function',
    `
**문자열의 Byte 길이**

- 인자1 : 문자열

\`\`\`abl
#なるほうど -> 10
@LengthB@(なるほうど@)
\`\`\`
    `
  ),
  ciSnippet('@Pos@(@,@)', '@Pos@(${1:find}@,${2:string}@)', 'Function',
    `
**문자열 내의 문자열의 위치**

- 인자1 : 찾을 문자열
- 인자2 : 문자열

\`\`\`abl
#abcdefg 에서 bcd의 위치 -> 2
@Pos@(bcd@abcdefg@)
\`\`\`
    `
  ),
  ciSnippet('@FilePath()', '@FilePath()', 'Function',
    `
**전환하는 프로그램의 파일 경로**

\`\`\`abl
#\\src\\java\\main
@FilePath()
\`\`\`
    `
  ),
  ciSnippet('@Trim@(@)', '@Trim@(${1:string}@)', 'Function',
    `
**문자열 앞/뒤의 불필요한 공백 제거**

- 인자1 : 문자열

\`\`\`abl
# abcdefg -> abcdefg
@Trim@( abcdefg@)
\`\`\`
    `
  ),
  ciSnippet('@Naming@(@,@)', '@Naming@(${1:string}@,${2:option}@)', 'Function',
    `
**Naming 규칙에 맞게 문자열 변경**

- 인자1 : 문자열
- 인자2 : 옵션

\`\`\`abl
# First : 첫문자 대분자, 나머지 소문자
# AAA_BBB_CCC -> Aaa_bbb_ccc
@Naming@(AAA_BBB_CCC@,First@)

# UpperCase : 모든 문자 대문자
# aaa_bbb_ccc -> AAA_BBB_CCC
@Naming@(aaa_bbb_ccc@,UpperCase@)

# LowerCase : 모든 문자 소문자
# AAA_BBB_CCC -> aaa_bbb_ccc
@Naming@(AAA_BBB_CCC@,LowerCase@)

# FirstLower : 첫 문자만 소문자, 나머지 그대로
# AAA_BBB_CCC -> aAA_BBB_CCC
@Naming@(AAA_BBB_CCC@,FirstLower@)

# FirstUpper : 첫 문자만 대문자, 나머지 그대로
# aaa_bbb_ccc -> Aaa_bbb_ccc
@Naming@(aaa_bbb_ccc@,FirstUpper@)

# Hungarian : _ 기준으로 처음 오는 문자만 대문자, 나머지는 소문자
# AAA_BBB_CCC -> aaaBbbCcc
@Naming@(AAA_BBB_CCC@,Hungarian@)

# Camel : _ 기준 첫 단어의 첫 글자만 소문자, 나머지는 Hungarian
# AAA_BBB_CCC -> aAABbbCcc
@Naming@(AAA_BBB_CCC@,Camel@)

# Pascal : 첫글자 대문자, 나머지는 Hungarian 처리
# AAA_BBB_CCC -> AAABbbCcc
@Naming@(AAA_BBB_CCC@,Pascal@)
\`\`\`
    `
  ),
  ciSnippet('@SysDateTime()', '@SysDateTime()', 'Function',
    `
**현재 시스템 날짜 및 시간 출력**

- 인자1 : 날짜 및 시간 출력 형식

\`\`\`abl
# 2026-01-01 09:00:05
@SysDateTime(YYYY-MM-DD HH:MM:SS)

# 2026/01/01
@SysDateTime(YYYY/MM/DD)
\`\`\`
    `
  ),
  ciSnippet('@GetTabSpace()', '@GetTabSpace()', 'Function',
    `
**Tab 개수 만큼의 공백을 줌**

- 인자1 : Tab 개수

\`\`\`abl
# Tab 1
@GetTabSpace(1)A ->     A

# Tab 2
@GetTabSpace(2)A ->         A
\`\`\`
    `
  ),
  ciSnippet('@GetSpace()', '@GetSpace()', 'Function',
    `
**공백 개수 만큼의 공백을 줌**

- 인자1 : 공백 개수

\`\`\`abl
# 공백 1개
@GetSpace(1)A ->  A

# 공백 3개
@GetSpace(3)A ->    A
\`\`\`
    `
  ),
  ciSnippet('@GetTokenSpace()', '@GetTokenSpace()', 'Function',
    `
**토큰의 공백과 탭 개수 만큼 공백과 탭을 줌**

- 인자1 : Tab 개수
- 인자2 : 공백 개수

\`\`\`abl
# Tab 1 , 공백 2
@GetTokenSpace(1,2)A ->       A
\`\`\`
    `
  ),
  ciSnippet('@Prespace()', '@Prespace(${1:token}) = ${2:spaces}', 'Function',
    `
**해당 토큰 앞에 space 추가**

- 인자1 : 토큰 넘버
- 설정값 : 공백 개수 

\`\`\`abl
# if(a>b) -> if( a>b)
@Prespace(3) = 1
\`\`\`
    `
  ),
  ciSnippet('@Pretab()', '@Pretab(${1:token}) = ${2:tabs}', 'Function',
    `
**해당 토큰 앞에 tab 추가**

- 인자1 : 토큰 넘버
- 설정값 : Tab 개수 

\`\`\`abl
# if(a>b) -> if(    a>b)
@Pretab(3) = 1
\`\`\`
    `
  ),
  ciSnippet('@Space()', '@Space(${1:token}) = ${2:spaces}', 'Function',
    `
**해당 토큰 뒤에 space 를 변경**

- 인자1 : 토큰 넘버
- 설정값 : space 개수 

\`\`\`abl
# if(a>b) -> if(a >b)
@Space(3) = 1
\`\`\`
    `
  ),

  // Query
  ciSnippet('@SetQueryClear()', '@SetQueryClear()', 'DB Function',
    `
**쿼리 문장 초기화** 

\`\`\`abl
@SetQueryClear()
\`\`\`
    `
  ),
  ciSnippet('@SetQueryAdd@(@)', '@SetQueryAdd@(${1:query}@)', 'DB Function',
    `
**쿼리 문장 추가** 

- 인자1 : 쿼리문

\`\`\`abl
@SetQueryAdd@(@Get(sQuery)@)
\`\`\`
    `
  ),
  ciSnippet('@GetSelectQueryResult()', '@GetSelectQueryResult()', 'DB Function',
    `
**Select문의 결과 값 1개 가져오기** 

\`\`\`abl
@GetSelectQueryResult()
\`\`\`
    `
  ),
  ciSnippet('@QueryExecution()', '@QueryExecution()', 'DB Function',
    `
**Insert, Update, Delete 실행** 

\`\`\`abl
@QueryExecution()
\`\`\`
    `
  ),
  ciSnippet('@QueryResultToMap()', '@QueryResultToMap()', 'DB Function',
    `
**다중 Select 값 가져와서 Map에 저장** 

\`\`\`abl
@QueryResultToMap()
\`\`\`
    `
  ),

  // Writer / Generation
  ciSnippet('@Data()', '@Data(${1:token}) = ${2:result}', 'Writer',
    `
**토큰 자리에 값 출력** 

- 인자1 : 토큰 넘버
- 설정값 : 결과

\`\`\`abl
# if(a>b) -> if(d>b)
@Data(3) = d
\`\`\`
    `
  ),
  ciSnippet('@Base()', '@Base(${1:token}) = ${2:result}', 'Writer',
    `
**다른 전환룰에 의해 전환되는걸 방지** 

- 인자1 : 토큰 넘버
- 설정값 : 결과

\`\`\`abl
@Base(3) = AA
\`\`\`
    `
  ),
  ciSnippet('@AddLine()', '@AddLine(${1:token}) = ${2:result}', 'Writer',
    `
**토큰의 뒤에 라인 추가** 

- 인자1 : 토큰 넘버
- 설정값 : 결과

\`\`\`abl
# if(a>b)
@AddLine(3) = addedLine
# if(a
# addedLine
# >b)
\`\`\`
    `
  ),
  ciSnippet('@InsertLine()', '@InsertLine(${1:token}) = ${2:result}', 'Writer',
    `
**토큰의 앞에 라인 추가** 

- 인자1 : 토큰 넘버
- 설정값 : 결과

\`\`\`abl
# if(a>b)
@InsertLine(3) = insertedLine
# if(
# insertedLine
# a>b)
\`\`\`
    `
  ),
  ciSnippet('@AddLinePrespace()', '@AddLinePrespace(${1:token},${2:spaces}) = ${3:result}', 'Writer',
    `
**토큰의 뒤에 라인 추가 및 공백 추가** 

- 인자1 : 토큰 넘버
- 인자2 : 공백 개수
- 설정값 : 결과

\`\`\`abl
# if(a>b)
@AddLine(3,2) = addedLine
# if(a
#   addedLine
# >b)
\`\`\`
    `
  ),
  ciSnippet('@InsertLinePrespace()', '@InsertLinePrespace(${1:token},${2:spaces}) = ${3:result}', 'Writer',
    `
**토큰의 앞에 라인 추가 및 공백 추가**

- 인자1 : 토큰 넘버
- 인자2 : 공백 개수
- 설정값 : 결과

\`\`\`abl
# if(a>b)
@InsertLine(3,3) = insertedLine
# if(
#    insertedLine
# a>b)
\`\`\`
    `
  ),
  ciSnippet('@GenerationCreateFile()', '@GenerationCreateFile(${1:abl file name}) = ${2:file path}, ${3:file name}, ${4:extension}, ${5:utf-8}', 'Create File',
    `
**파일 생성하기** 

- 인자1 : abl 파일 이름
- 설정값1 : 파일 경로
- 설정값2 : 파일 이름
- 설정값3 : 파일 확장자
- 설정값4 : utf-8 (생략 가능)

\`\`\`abl
@GenerationCreateFile(test.abl) = src\java\main, TestFile, java
\`\`\`
    `
  ),
  ciSnippet('@Tobe_File_Path()', '@Tobe_File_Path(${1:file path})', 'File Path',
    `
**전환 후 파일의 생성 경로** 

- 인자1 : 파일의 경로

\`\`\`abl
@Tobe_File_Path(src\java\main)
\`\`\`
    `
  ),
  ciSnippet('@Tobe_File_Name()', '@Tobe_File_Name(${1:file name})', 'File Name',
    `
**전환 후 파일의 이름** 

- 인자1 : 파일의 이름

\`\`\`abl
@Tobe_File_Name(NewFile.java)
\`\`\`
    `
  ),
];

const COMPLETIONS_AT_NO_PREFIX = cloneWithoutPrefix(COMPLETIONS_AT, withoutLeadingAt);

/* --------------------------
 * @Map. 컨텍스트 전용 (Get/Set/Clear)
 *  - label은 짧게(Get/Set/Clear)
 *  - doc는 풀 형태(@Map.Get@(@))로 제공
 * -------------------------- */
const COMPLETIONS_MAP_DOT: vscode.CompletionItem[] = [
  ciSnippet('Get','Get@(${1:value}@)','Map',
  `
**Map에 저장된 Key 값 가져오기**

- 인자1: Key

\`\`\`abl
# ValueAndForce 값 가져요가
@Map.Get@(Company_Name@)
\`\`\`
`
  ),
  ciSnippet('Set','Set@(${1:key}@,${2:value}@)','Map',
  `
**Map에 값 저장**

- 인자1: Key
- 인자2: Value

\`\`\`abl
# Company_Name 이라는 Key 값에 ValueAndForce라는 값 저장
@Map.Set@(Company_Name@,ValueAndForce@)
\`\`\`
`
  ),
  ciSnippet('Clear','Clear()','Map',
  `
**Map 값 초기화**
예:
\`\`\`abl
# 저장된 모든 Map 값 삭제
@Map.Clear()

# Company_Name 이라는 Key 값 삭제
@Map.Clear(Company_Name)

# Company_ 가 Key인 모든 Map 값 삭제 (구분자 : _*)
@Map.Clear(Company__*)
\`\`\`
`
  )
];

const DATA_ITEM_DOC: Record<string, string> = {
'Name!': '**AS-IS 토큰명**\n- 현재 토큰의 이름\n',
'Tobe!': '**TO-BE 토큰명**\n- 전환 규칙이 적용된 토큰 이름\n',
'Type!': '**AS-IS 토큰 타입**\n- 현재 토큰의 자료형\n',
'TobeType!': '**TO-BE 토큰 타입**\n- 전환 규칙이 적용된 토큰의 자료형\n',
'Length!': '**AS-IS 토큰 길이**\n- 현재 토큰의 길이\n',
'NewLine!': '**AS-IS 토큰 줄 시작 여부**\n- 현재 토큰이 라인의 시작이면 `Y`, 아니면 `N`\n',
'Line!': '**AS-IS 토큰 라인 번호**\n- 현재 토큰이 위치한 라인 번호\n',
'Block_Level!': '**AS-IS 토큰 블록 레벨**\n- 현재 토큰의 블록 레벨\n',
'Level!': '**AS-IS 토큰 레벨**\n- 현재 토큰의 레벨\n',
'Format!': '**AS-IS 토큰 포맷**\n- 현재 토큰의 출력(format) 정보\n',
'Prespace!': '**AS-IS 토큰 앞 공백 수**\n- 현재 토큰 앞에 존재하는 공백 개수\n',
'Pretab!': '**AS-IS 토큰 앞 탭 수**\n- 현재 토큰 앞에 존재하는 탭 개수\n',
'Column!': '**AS-IS 토큰 컬럼 위치**\n- 현재 토큰이 위치한 컬럼 번호\n',
};

const DATA_STRINGTOKEN_DOC: Record<string, string> = {
  'Name!': '**AS-IS 토큰명**\n- StringTokenInfo 토큰의 이름\n',
  'Tobe!': '**TO-BE 토큰명**\n- 전환 규칙이 적용된 토큰 이름\n',
  'Type!': '**AS-IS 토큰 타입**\n- StringTokenInfo 토큰의 자료형\n',
  'TobeType!': '**TO-BE 토큰 타입**\n- 전환 규칙이 적용된 토큰의 자료형\n',
  'Length!': '**AS-IS 토큰 길이**\n- StringTokenInfo 토큰의 길이\n',
  'NewLine!': '**AS-IS 토큰 줄 시작 여부**\n- 라인의 시작이면 `Y`, 아니면 `N`\n',
  'Line!': '**AS-IS 토큰 라인 번호**\n- StringTokenInfo 토큰이 위치한 라인 번호\n',
  'Block_Level!': '**AS-IS 토큰 블록 레벨**\n- StringTokenInfo 토큰의 블록 레벨\n',
  'Level!': '**AS-IS 토큰 레벨**\n- StringTokenInfo 토큰의 레벨\n',
  'Format!': '**AS-IS 토큰 포맷**\n- 출력(format) 정보\n',
  'Prespace!': '**AS-IS 토큰 앞 공백 수**\n- StringTokenInfo 토큰의 앞 공백 개수\n',
  'Pretab!': '**AS-IS 토큰 앞 탭 수**\n- StringTokenInfo 토큰의 앞 탭 개수\n',
  'Column!': '**AS-IS 토큰 컬럼 위치**\n- StringTokenInfo 토큰의 컬럼 번호\n',
};


const DATA_ROOT_DOC: Record<string, string> = {
  'Count!': '**토큰의 총 개수**\n- 잡힌 전체 범위의 토큰 개수\n',
};

const CLASS_ROOT_DOC = `**클래스/환경 정보**\n- 전환 대상 클래스 메타 정보\n`;

const CLASS_PROP_DOC: Record<string, string> = {
  'Name!': '**AS-IS 파일명**\n- 전환하는 파일의 이름\n',
  'Tobe!': '**TO-BE 파일명**\n- 등록이 되어있는 경우 TO-BE 파일명, 그렇지 않은 경우에는 AS-IS 파일명\n',
  'Package!': '**자바 파일의 패키지명**\n- 자바 파일인 경우 속한 패키지명을 가지고 옴\n',
  'Extends!': '**AS-IS 파일의 확장자**\n- 전환하는 파일의 확장자\n',
};

/* --------------------------
 * ^ 시작 컨텍스트
 * -------------------------- */
const COMPLETIONS_CARET: vscode.CompletionItem[] = [
  (() => {
    const item = ciProperty('^Class', '^Class.', '^Class', docFor('^Class.', CLASS_ROOT_DOC));
    item.command = { title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' };
    return item;
  })(),
  (() => {
    const item = ciProperty('^Data', '^Data.', '^Data', docFor('^Data.', '토큰에 대한 정본'));
    item.command = { title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' };
    return item;
  })(),
];

const COMPLETIONS_CARET_NO_PREFIX = cloneWithoutPrefix(COMPLETIONS_CARET, withoutLeadingCaret);

/* --------------------------
 * ^Class.* / ^Data.* / ^Data.Item[].* / ^Data.Item[].StringTokenInfo[].*
 *  - label: 짧게(Count!, Item[]., Name!, ...)
 *  - insert: suffix만 (중복 방지)
 *  - doc: full path로 제공
 * -------------------------- */
const CLASS_PROPS = ['Name!', 'Tobe!', 'Package!', 'Extends!'];
const DATA_ROOT_SUFFIXES = ['Count!', 'Item[].']; // ★ 여기서 Item[]. 제공

const DATA_ITEM_PROPS = [
  'Name!', 'Tobe!', 'Type!', 'TobeType!', 'Length!', 'NewLine!', 'Line!',
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!',
];

const DATA_STRINGTOKEN_PROPS = [
  'Name!', 'Tobe!', 'Type!', 'TobeType!', 'Length!', 'NewLine!', 'Line!',
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!',
];

function docFor(full: string, extra?: string) {
  return `
\`\`\`abl
${full}
\`\`\`
${extra ? `\n${extra}\n` : ''}
`;
}

const DOT_CLASS_ITEMS = makeDotSuffixItems(
  '^Class.',
  CLASS_PROPS,
  '^Class',
  (full) => {
    const sfx = full.replace('^Class.', ''); // Name! 등
    return docFor(full, CLASS_PROP_DOC[sfx]);
  }
);

const DOT_DATA_ITEMS = [
  // Count!
  ...makeDotSuffixItems(
    '^Data.',
    ['Count!'],
    '^Data',
    (full) => {
      const sfx = full.replace('^Data.', ''); // Count!
      return docFor(full, DATA_ROOT_DOC[sfx]);
    }
  ),
  // Item[].  (선택하면 다음 추천창 자동 트리거)
  ...makeDotSuffixItems(
    '^Data.',
    ['Item[].'],
    '^Data',
    (full) => docFor(full, '현재 토큰에 대한 정보.'),
    true // ★ auto trigger suggest
  ),
];

const DOT_DATA_ITEM_BASE = makeDotSuffixItems(
  '^Data.Item[].',
  DATA_ITEM_PROPS,
  '^Data.Item[]',
  (full) => {
    const sfx = full.replace('^Data.Item[].', ''); // "Name!" 추출
    return docFor(full, DATA_ITEM_DOC[sfx]);
  }
);

// StringTokenInfo[]. 추가 확장
function extendDataItemDotItems(base: vscode.CompletionItem[]): vscode.CompletionItem[] {
  const stringToken = ciProperty(
    'StringTokenInfo[].',
    'StringTokenInfo[].', // 반드시 '.' 포함
    '^Data.Item[]',
    docFor(
      '^Data.Item[].StringTokenInfo[].',
      '문자열을 토큰화 시킨 정본'
    )
  );

  // 선택 즉시 다음 단계 자동 추천
  stringToken.command = {
    title: 'Trigger Suggest',
    command: 'editor.action.triggerSuggest'
  };

  return [stringToken, ...base];
}

// 최종 사용
const DOT_DATA_ITEM_ITEMS = extendDataItemDotItems(DOT_DATA_ITEM_BASE);

const DOT_DATA_STRINGTOKEN_ITEMS = makeDotSuffixItems(
  '^Data.Item[].StringTokenInfo[].',
  DATA_STRINGTOKEN_PROPS,
  '^Data.StringTokenInfo[]',
  (full) => docFor(full)
);

function getDotContext(lineBeforeCursor: string):
  | 'class'
  | 'data'
  | 'dataItem'
  | 'dataStringToken'
  | null {
  const s = lineBeforeCursor;
  // 가장 구체적인 것부터
  if (/\^Data\.Item\[\]\.StringTokenInfo\[\]\.\s*$/.test(s)) return 'dataStringToken';
  if (/\^Data\.Item\[\]\.\s*$/.test(s)) return 'dataItem';
  if (/\^Data\.\s*$/.test(s)) return 'data';
  if (/\^Class\.\s*$/.test(s)) return 'class';
  return null;
}

/**
 * 현재 커서 앞 토큰을 간단히 얻는다 (공백 기준).
 * - ABL은 기호가 많아서 "완전 파서"는 피하고, 실사용 기준으로 보수적으로만 잡음.
 */
function lastTokenOf(before: string) {
  return before.split(/\s+/).pop() ?? '';
}

const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, pos.character);

    // 1) '.' 트리거: ^Class. / ^Data. / ...
    if (before.endsWith('.')) {
      // @Map. 컨텍스트
      if (/@Map\.\s*$/.test(before)) {
        return COMPLETIONS_MAP_DOT;
      }

      // ^ 컨텍스트
      const ctx = getDotContext(before);
      if (ctx === 'class') return DOT_CLASS_ITEMS;
      if (ctx === 'data') return DOT_DATA_ITEMS;
      if (ctx === 'dataItem') return DOT_DATA_ITEM_ITEMS;
      if (ctx === 'dataStringToken') return DOT_DATA_STRINGTOKEN_ITEMS;
      return undefined;
    }

    // 2) '^' 트리거 직후: '^'는 이미 입력됐으니 prefix 없는 삽입
    if (before.endsWith('^')) {
      return COMPLETIONS_CARET_NO_PREFIX;
    }

    // 3) '@' 트리거 직후: '@'는 이미 입력됐으니 prefix 없는 삽입
    if (before.endsWith('@')) {
      return COMPLETIONS_AT_NO_PREFIX;
    }

    // 4) Ctrl+Space 케이스: 이미 "@..." 일부를 치고 호출
    const last = lastTokenOf(before);

    // @Map. 을 이미 치고 Ctrl+Space
    if (last.startsWith('@Map.')) {
      // 사용자가 @Map.까지는 쳤으니, "Get/Set/Clear"만 추천
      return COMPLETIONS_MAP_DOT;
    }

    if (last.startsWith('@')) return COMPLETIONS_AT;
    if (last.startsWith('^')) return COMPLETIONS_CARET;

    return undefined;
  }
};

/* ============================================================
 * Semantic Tokens
 * ============================================================ */
function provideTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
  const builder = new vscode.SemanticTokensBuilder(legend);

  // 라인 단위로만 컨텍스트를 유지: 라인 끝나면 무조건 초기화됨
  for (let line = 0; line < doc.lineCount; line++) {
    const lineText = doc.lineAt(line).text;
    const baseOffset = doc.offsetAt(new vscode.Position(line, 0));

    // ---- line-local state (다음 줄로 절대 안 넘어감) ----
    const stack: Frame[] = [];
    let ifMode = false;
    let ifParenDepth = 0;
    let inSingleQuote = false;

    const mapName = /@Map\.(Get|Set)@?/y;
    const funcName = /@[A-Za-z_][A-Za-z0-9_]*@?/y;

    const top = () => (stack.length ? stack[stack.length - 1] : undefined);

    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];

      // ---- single quote skip (라인 내부) ----
      if (ch === "'") {
        const next = lineText[i + 1];

        if (inSingleQuote) {
          if (next === "'") i++;
          else inSingleQuote = false;
        } else {
          if (next === "'") i++;
          else inSingleQuote = true;
        }
        continue;
      }
      if (inSingleQuote) continue;

      // ---- ^Data.* / ^Class.* (메타 토큰) ----
      if (ch === '^') {
        const meta = /\^(Data|Class)(?:\.[A-Za-z0-9_\[\]]+)*!?/y;
        meta.lastIndex = i;
        const m = meta.exec(lineText);
        if (m) {
          const len = meta.lastIndex - i;
          pushToken(builder, doc, baseOffset + i, len, 'ablFunc'); // 색은 기존 ablFunc 사용
          i += len - 1;
          continue;
        }
      }

      // ---- If / ElseIf mode ----
      const isIf = lineText.startsWith('@If', i) && isWordBoundary(lineText, i, 3);
      const isElseIf =
        lineText.startsWith('@Else', i) &&
        isWordBoundary(lineText, i, 5) &&
        /\s+If\b/.test(lineText.slice(i + 5, i + 20));

      if (isIf || isElseIf) {
        ifMode = true;
        ifParenDepth = 0;

        let j = isIf ? i + 3 : i + 5;
        while (j < lineText.length && /\s/.test(lineText[j])) j++;
        if (!isIf && lineText.startsWith('If', j)) j += 2;
        while (j < lineText.length && /\s/.test(lineText[j])) j++;
        if (lineText[j] === '@') j++;
        while (j < lineText.length && /\s/.test(lineText[j])) j++;

        if (lineText[j] === '(') {
          ifParenDepth = 1;
          i = j;
        }
        continue;
      }

      if (
        ifMode &&
        (lineText.startsWith('@Then', i) || lineText.startsWith('@Else', i)) &&
        isWordBoundary(lineText, i, 5) &&
        !(lineText.startsWith('@Else', i) && /\s+If\b/.test(lineText.slice(i + 5, i + 20)))
      ) {
        ifMode = false;
        ifParenDepth = 0;
        continue;
      }

      // ---- If logic tokens ----
      if (ifMode || ifParenDepth > 0) {
        if (lineText.startsWith('And', i) && isWordBoundary(lineText, i, 3)) {
          pushToken(builder, doc, baseOffset + i, 3, 'ablLogic');
          i += 2;
          continue;
        }
        if (lineText.startsWith('Or', i) && isWordBoundary(lineText, i, 2)) {
          pushToken(builder, doc, baseOffset + i, 2, 'ablLogic');
          i += 1;
          continue;
        }
        if (lineText.startsWith('>=', i) || lineText.startsWith('<=', i) || lineText.startsWith('<>', i)) {
          pushToken(builder, doc, baseOffset + i, 2, 'ablLogic');
          i += 1;
          continue;
        }
        if (ch === '=' || ch === '>' || ch === '<') {
          pushToken(builder, doc, baseOffset + i, 1, 'ablLogic');
          continue;
        }
      }

      // ---- Map context ----
      mapName.lastIndex = i;
      const mm = mapName.exec(lineText);
      if (mm) {
        let j = mapName.lastIndex;
        while (j < lineText.length && /\s/.test(lineText[j])) j++;
        if (lineText[j] === '@') j++;
        if (lineText[j] === '(') {
          pushToken(builder, doc, baseOffset + i, mapName.lastIndex - i, 'ablMap');
          stack.push({ kind: 'ablMap', depth: 1 });
          i = j;
          continue;
        }
      }

      // ---- Func context (writer 제외) ----
      funcName.lastIndex = i;
      const fm = funcName.exec(lineText);
      if (fm) {
        const raw = fm[0];
        const name = raw.replace(/@/g, '');

        if (
          name.startsWith('Map.') ||
          name === 'If' ||
          name === 'If@' ||
          WRITER_KEYWORDS.has(name)
        ) {
          // tmLanguage 색 유지
        } else {
          let j = funcName.lastIndex;
          while (j < lineText.length && /\s/.test(lineText[j])) j++;
          if (lineText[j] === '@') j++;

          if (lineText[j] === '(') {
            pushToken(builder, doc, baseOffset + i, funcName.lastIndex - i, 'ablFunc');
            stack.push({ kind: 'ablFunc', depth: 1 });
            i = j;
            continue;
          }
        }
      }

      // ---- Inner @ (원래 규칙 유지) ----
      if (stack.length > 0 && ch === '@') {
        const t = top();
        if (t) {
          const prev = i > 0 ? lineText[i - 1] : '';
          const next = i + 1 < lineText.length ? lineText[i + 1] : '';

          const beforePunct = isAttachPunct(next);
          const afterPunct = isAttachPunct(prev);
          const afterIdent = isIdentChar(prev);

          if (beforePunct || afterPunct || afterIdent) {
            pushToken(builder, doc, baseOffset + i, 1, t.kind);
          }
        }
      }

      // ---- Depth tracking (라인 내부) ----
      if (ifParenDepth > 0) {
        if (ch === '(') ifParenDepth++;
        else if (ch === ')') if (--ifParenDepth === 0) ifMode = false;
      }

      if (stack.length > 0) {
        if (ch === '(') stack[stack.length - 1].depth++;
        else if (ch === ')' && --stack[stack.length - 1].depth === 0) stack.pop();
      }
    }
  }

  return builder.build();
}

/* ============================================================
 * Diagnostic (If + For)
 * ============================================================ */
const diag = vscode.languages.createDiagnosticCollection('abl');

function isQuotedOperandOk(op: string): boolean {
  const t = stripOuterParens(op).trim();
  if (!t.startsWith("'")) return true; // 문자열 항 아님
  return t.endsWith("'");              // 문자열이면 끝 따옴표만 확인(보수적)
}

function hasThenNearNextLine(doc: vscode.TextDocument, fromLine: number): boolean {
  for (let i = fromLine + 1; i < Math.min(doc.lineCount, fromLine + 3); i++) {
    const raw = doc.lineAt(i).text;
    if (!raw.trim()) continue;
    if (isCommentLine(raw)) continue;
    return /^\s*@Then\b/i.test(raw);
  }
  return false;
}

function provideIfDiagnostics(doc: vscode.TextDocument) {
  if (doc.languageId !== 'abl') return;

  const diagnostics: vscode.Diagnostic[] = [];
  const ifStack: number[] = [];

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (isCommentLine(text)) continue;

    const isIf = /^\s*@If\b/i.test(text);
    const isElseIf = /^\s*@Else\s+If\b/i.test(text);

    if (isIf || isElseIf) {
      const hasThenSameLine = /@Then\b/i.test(text);
      const hasThen = hasThenSameLine ? true : hasThenNearNextLine(doc, line);

      if (!hasThen) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, text.length),
            '@If / @Else If 문에 @Then 이 없습니다.',
            vscode.DiagnosticSeverity.Error
          )
        );
      }

      const thenIdx = text.toLowerCase().indexOf('@then');
      let condAll = thenIdx >= 0 ? text.slice(0, thenIdx) : text;

      condAll = condAll.replace(/^\s*@If\b/i, '');
      condAll = condAll.replace(/^\s*@Else\s+If\b/i, '');

      const parts = splitByAndOrTopLevel(condAll);

      for (const p of parts) {
        const cmp = splitCompareTopLevel(p);
        if (!cmp) continue;

        const left = cmp.left;
        const right = cmp.right;

        if (!isQuotedOperandOk(left) || !isQuotedOperandOk(right)) {
          diagnostics.push(
            new vscode.Diagnostic(
              new vscode.Range(line, 0, line, text.length),
              "비교 항의 문자열(')이 닫히지 않았습니다.",
              vscode.DiagnosticSeverity.Error
            )
          );
          break;
        }
      }

      if (isIf) ifStack.push(line);
      continue;
    }

    if (/^\s*@End\s+If\b/i.test(text)) {
      if (ifStack.length === 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, text.length),
            '@End If 에 대응되는 @If 가 없습니다.',
            vscode.DiagnosticSeverity.Error
          )
        );
      } else {
        ifStack.pop();
      }
    }
  }

  for (const line of ifStack) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(line, 0, line, doc.lineAt(line).text.length),
        '@If 에 대응되는 @End If 가 없습니다.',
        vscode.DiagnosticSeverity.Error
      )
    );
  }

  provideForDiagnostics(doc, diagnostics);
  diag.set(doc.uri, diagnostics);
}

function provideForDiagnostics(doc: vscode.TextDocument, diagnostics: vscode.Diagnostic[]) {
  const forStack: number[] = [];

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (isCommentLine(text)) continue;

    if (/^\s*@For\b/i.test(text)) {
      forStack.push(line);
      continue;
    }

    if (/^\s*@End\s+For\b/i.test(text)) {
      if (forStack.length === 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, text.length),
            '@End For 에 대응되는 @For 가 없습니다.',
            vscode.DiagnosticSeverity.Error
          )
        );
      } else {
        forStack.pop();
      }
    }
  }

  for (const line of forStack) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(line, 0, line, doc.lineAt(line).text.length),
        '@For 에 대응되는 @End For 가 없습니다.',
        vscode.DiagnosticSeverity.Error
      )
    );
  }
}

/* ============================================================
 * Extension lifecycle
 * ============================================================ */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(diag);

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'abl' },
      { provideDocumentSemanticTokens: provideTokens },
      legend
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(provideIfDiagnostics),
    vscode.workspace.onDidChangeTextDocument(e => provideIfDiagnostics(e.document))
  );

  if (vscode.window.activeTextEditor) {
    provideIfDiagnostics(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'abl' },
      completionProvider,
      '@', '^', '.'
    )
  );
}

export function deactivate() {}
