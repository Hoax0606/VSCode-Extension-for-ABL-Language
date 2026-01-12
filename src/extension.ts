import * as vscode from 'vscode';

/**
 * Semantic token legend
 * - ablMap          : Map 계열 (@Map.Get / @Map.Set) + 그 호출에 속한 모든 @
 * - ablFunc         : (미리 등록된) 일반 함수 (@Replace, @Get, @Pos 등) + 그 호출에 속한 모든 @
 * - ablLogic        : If 조건식 내 And/Or, 비교연산자 (+, = 포함)
 * - ablData         : ^Data / ^Class
 * - ablFunctionDecl : @Function + functionName
 * - ablFunctionEnd  : @End Function
 * - ablFunctionCall : (미등록) @functionName (사용자 정의 함수 호출로 취급) + 그 호출에 속한 모든 @
 */
const legend = new vscode.SemanticTokensLegend(
  ['ablMap', 'ablFunc', 'ablLogic', 'ablData', 'ablFunctionDecl', 'ablFunctionEnd', 'ablFunctionCall', 'ablReturn'],
  []
);

/** 선언이 뒤에 있어도 호출 색칠이 되게 만들기 위해: "선언 기반 userFunctions"는 색칠 판단에 쓰지 않는다(필요하면 유지 용도). */
const userFunctions = new Set<string>();

type CtxKind = 'ablMap' | 'ablFunc' | 'ablFunctionCall';
type Frame = { kind: CtxKind; depth: number };
type TokenKind =
  | 'ablMap'
  | 'ablFunc'
  | 'ablLogic'
  | 'ablData'
  | 'ablFunctionDecl'
  | 'ablFunctionEnd'
  | 'ablFunctionCall'
  | 'ablReturn';

/**
 * ✅ 함수 목록 단일 소스
 * - kind: 'builtin' => semantic에서 ablFunc로 칠함
 * - kind: 'writer'  => completion은 제공해도 semantic은 tmLanguage에 맡김(덮어쓰기 방지)
 *
 * NOTE: "관리하는 애는 무조건 색칠" 정책이면 전부 builtin으로 두면 됨.
 *       지금은 Writer 류만 예외로 분리(기존 동작 유지).
 */
type BuiltinKind = 'builtin' | 'writer';
const FUNCTION_META: ReadonlyArray<{ name: string; kind: BuiltinKind }> = [
  // Functions
  { name: 'Get', kind: 'builtin' },
  { name: 'Set', kind: 'builtin' },
  { name: 'UpperCase', kind: 'builtin' },
  { name: 'LowerCase', kind: 'builtin' },
  { name: 'SubString', kind: 'builtin' },
  { name: 'Replace', kind: 'builtin' },
  { name: 'Length', kind: 'builtin' },
  { name: 'LengthB', kind: 'builtin' },
  { name: 'Pos', kind: 'builtin' },
  { name: 'FilePath', kind: 'builtin' },
  { name: 'Trim', kind: 'builtin' },
  { name: 'Naming', kind: 'builtin' },
  { name: 'SysDateTime', kind: 'builtin' },
  { name: 'GetTabSpace', kind: 'builtin' },
  { name: 'GetSpace', kind: 'builtin' },
  { name: 'GetTokenSpace', kind: 'builtin' },
  { name: 'Prespace', kind: 'builtin' },
  { name: 'Pretab', kind: 'builtin' },
  { name: 'Space', kind: 'builtin' },

  // Query / DB
  { name: 'SetQueryClear', kind: 'builtin' },
  { name: 'SetQueryAdd', kind: 'builtin' },
  { name: 'GetSelectQueryResult', kind: 'builtin' },
  { name: 'QueryExecution', kind: 'builtin' },
  { name: 'QueryResultToMap', kind: 'builtin' },

  // Writer (semantic 덮어쓰기 방지: tmLanguage 유지)
  { name: 'Data', kind: 'writer' },
  { name: 'Base', kind: 'writer' },
  { name: 'AddLine', kind: 'writer' },
  { name: 'InsertLine', kind: 'writer' },
  { name: 'AddLinePrespace', kind: 'writer' },
  { name: 'InsertLinePrespace', kind: 'writer' },

  // Generation / File
  { name: 'GenerationCreateFile', kind: 'builtin' },
  { name: 'Tobe_File_Path', kind: 'builtin' },
  { name: 'Tobe_File_Name', kind: 'builtin' }
] as const;

/** tmLanguage 색(예: support.function.writer)을 덮어쓰지 않도록 Semantic에서 제외할 키워드 */
const WRITER_KEYWORDS = new Set<string>(FUNCTION_META.filter(f => f.kind === 'writer').map(f => f.name));

/**
 * ✅ 미리 등록한(내장) 함수들
 * - 여기에 있는 것만 ablFunc로 칠해짐
 * - 그 외 @Something( 은 전부 ablFunctionCall(사용자 함수로 취급)
 */
const BUILTIN_FUNCTIONS = new Set<string>(FUNCTION_META.filter(f => f.kind === 'builtin').map(f => f.name));

/** @로 시작하지만 "함수 호출"로 취급하면 안 되는 컨트롤/키워드들 */
const AT_CONTROL_WORDS = new Set([
  'If',
  'Then',
  'Else',
  'For',
  'End',
  'Break',
  'Continue',
  'Function' // @Function 선언문
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
        if (next === "'") {
          i++;
          continue;
        }
        inQ = false;
        continue;
      } else {
        if (next === "'") {
          i++;
          continue;
        }
        inQ = true;
        continue;
      }
    }
    if (inQ) continue;

    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
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
        if (next === "'") {
          i++;
          continue;
        }
        inQ = false;
        continue;
      } else {
        if (next === "'") {
          i++;
          continue;
        }
        inQ = true;
        continue;
      }
    }
    if (inQ) continue;

    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      continue;
    }
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
    c.command = it.command;

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
    const label = sfx;
    const insert = sfx;
    const full = prefixForDoc + sfx;

    const item = ciProperty(label, insert, detail, docBuilder ? docBuilder(full) : `\`\`\`abl\n${full}\n\`\`\``);

    if (autoTriggerSuggest) {
      item.command = { title: 'Trigger Suggest', command: 'editor.action.triggerSuggest' };
    }
    return item;
  });
}

/* --------------------------
 * @ 전체 목록 (Ctrl+Space or @ 트리거)
 * -------------------------- */
const COMPLETIONS_AT: vscode.CompletionItem[] = [
  // Function Decl / End
  ciSnippet(
    '@Function()',
    '@Function()\n\t#----------------------------------------------------------------------------\n\t# Variables\n\t#----------------------------------------------------------------------------\n\t#\n\t# Boolean Variable\n\t#\n\t# String Variable\n\t#\n\t# Int Variable\n\t#\n\t# Initialize Variable\n\t#----------------------------------------------------------------------------\n\t# Main Logic\n\t#----------------------------------------------------------------------------\n@End Function',
    'Function',
    `
**사용자 정의 함수**

- 예:
\`\`\`abl
@Function FUNC_NAME()
    body
@End Function
\`\`\`

- 파라미터가 있으면:
\`\`\`abl
@Function FUNC_NAME(pParam1,pParam2)
    body
@End Function
\`\`\`
`
  ),

  (() => {
    const item = ciKeyword(
      '@End Function',
      '@End Function',
      'Function',
      `
**사용자 정의 함수 종료**

\`\`\`abl
@End Function
\`\`\`
`
    );
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),

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

  (() => {
    const item = ciSnippet('@Else If ... @Then','@Else If ${1:condition} @Then','Control',
      `
**Else If 조건문**

\`\`\`abl
@Else If condition @Then
    statement
\`\`\``
    );
    // Completion으로 입력 시에도 outdent/indent 규칙이 적용되게
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
  (() => {
    const item = ciKeyword('@Else', '@Else', 'Control', `Else문\`\`\`abl\n@Else\n\`\`\``);
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
  (() => {
    const item = ciKeyword('@End If', '@End If', 'Control', `If문 종료\`\`\`abl\n@End If\n\`\`\``);
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
  ciSnippet('@For ... @End For','@For %${1:index} ${2:start} : ${3:end}\n\t${4:statememt}\n@End For','Loop',
    `
**For 반복문**

\`\`\`abl
@For condition
  statement
@End For\`\`\``
  ),
  (() => {
    const item = ciKeyword('@End For', '@End For', 'Loop', `For문 종료\`\`abl\n@End For\n\`\`\``);
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
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
@GenerationCreateFile(test.abl) = src\\java\\main, TestFile, java

@GenerationCreateFile(test.abl) = src\\java\\main, TestFile, java, utf-8
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

/* ============================================================
 * Hover가 CompletionItem.documentation 을 그대로 재사용할 수 있게
 * @함수명 -> Markdown 문서 인덱스 생성
 * ============================================================ */
function labelToString(label: vscode.CompletionItemLabel | string): string {
  return typeof label === 'string' ? label : label.label;
}

function extractAtNameFromLabel(label: string): string | null {
  // 예) "@Data()", "@AddLine()", "@SetQueryAdd@(@)", "@End Function"
  if (!label.startsWith('@')) return null;

  // @Map.* 은 Hover에서 별도 처리하므로 여기서는 제외
  if (label.startsWith('@Map.')) return null;

  // '@' 다음부터 식별자만 추출
  let i = 1;
  let name = '';
  while (i < label.length) {
    const ch = label[i];
    if (/[A-Za-z0-9_]/.test(ch)) {
      name += ch;
      i++;
      continue;
    }
    break;
  }

  return name ? name : null;
}

const COMPLETION_DOC_BY_FUNC = new Map<string, vscode.MarkdownString>();

// COMPLETIONS_AT 의 documentation 을 name 기준으로 재사용
for (const it of COMPLETIONS_AT) {
  const doc = it.documentation;
  if (!doc) continue;

  const label = labelToString(it.label);
  const name = extractAtNameFromLabel(label);
  if (!name) continue;

  // 컨트롤/키워드는 Hover에서 제외
  if (AT_CONTROL_WORDS.has(name)) continue;

  // Completion에서 만든 문서를 Hover에서도 그대로 사용
  if (doc instanceof vscode.MarkdownString) {
    COMPLETION_DOC_BY_FUNC.set(name, doc);
  } else {
    // string/MarkdownString 둘 다 올 수 있으므로 보수적으로 처리
    COMPLETION_DOC_BY_FUNC.set(name, md(String(doc)));
  }
}


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
'Column!': '**AS-IS 토큰 컬럼 위치**\n- 현재 토큰이 위치한 컬럼 번호\n'
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
  'Column!': '**AS-IS 토큰 컬럼 위치**\n- StringTokenInfo 토큰의 컬럼 번호\n'
};

const DATA_ROOT_DOC: Record<string, string> = {
  'Count!': '**토큰의 총 개수**\n- 잡힌 전체 범위의 토큰 개수\n'
};

const CLASS_ROOT_DOC = `**전환 파일 정보**\n- 전환 파일에 대한 정보\n`;

const CLASS_PROP_DOC: Record<string, string> = {
  'Name!': '**AS-IS 파일명**\n- 전환하는 파일의 이름\n',
  'Tobe!': '**TO-BE 파일명**\n- 등록이 되어있는 경우 TO-BE 파일명, 그렇지 않은 경우에는 AS-IS 파일명\n',
  'Package!': '**자바 파일의 패키지명**\n- 자바 파일인 경우 속한 패키지명을 가지고 옴\n',
  'Extends!': '**AS-IS 파일의 확장자**\n- 전환하는 파일의 확장자\n'
};

/* --------------------------
 * ^ 시작 컨텍스트 (예시는 최소만)
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
  })()
];


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
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!'
];

const DATA_STRINGTOKEN_PROPS = [
  'Name!', 'Tobe!', 'Type!', 'TobeType!', 'Length!', 'NewLine!', 'Line!',
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!'
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
  (full) => {
    const sfx = full.replace('^Data.Item[].StringTokenInfo[].', ''); // Name! 등
    return docFor(full, DATA_STRINGTOKEN_DOC[sfx]);
  }
);

function getDotContext(lineBeforeCursor: string):
  | 'class'
  | 'data'
  | 'dataItem'
  | 'dataStringToken'
  | null {
  const s = lineBeforeCursor;
  // 가장 구체적인 것부터
  if (/\^Data\.Item\[\]\.StringTokenInfo(\[\])?\.\s*$/.test(s)) return 'dataStringToken';
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

function withReplaceRange(
  items: vscode.CompletionItem[],
  doc: vscode.TextDocument,
  pos: vscode.Position,
  replaceFromChar: number
): vscode.CompletionItem[] {
  const range = new vscode.Range(pos.line, replaceFromChar, pos.line, pos.character);
  return items.map(it => {
    const c = new vscode.CompletionItem(it.label, it.kind);
    c.detail = it.detail;
    c.documentation = it.documentation;
    c.sortText = it.sortText;
    c.filterText = it.filterText;
    c.preselect = it.preselect;
    c.command = it.command;
    c.insertText = it.insertText;
    c.range = range;
    return c;
  });
}

function findLastTriggerIndex(before: string, trigger: '@' | '^'): number {
  // Replace from the last trigger character in the current line fragment.
  // This fixes cases like: user types '@' then accepts '@If' => previously produced '@@If'.
  return before.lastIndexOf(trigger);
}

const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, pos.character);

    if (before.endsWith('.')) {
      if (/@Map\.\s*$/.test(before)) return COMPLETIONS_MAP_DOT;

      const ctx = getDotContext(before);
      if (ctx === 'class') return DOT_CLASS_ITEMS;
      if (ctx === 'data') return DOT_DATA_ITEMS;
      if (ctx === 'dataItem') return DOT_DATA_ITEM_ITEMS;
      if (ctx === 'dataStringToken') return DOT_DATA_STRINGTOKEN_ITEMS;
      return undefined;
    }

    if (before.endsWith('^')) {
      const from = findLastTriggerIndex(before, '^');
      if (from >= 0) return withReplaceRange(COMPLETIONS_CARET, doc, pos, from);
      return COMPLETIONS_CARET;
    }
    if (before.endsWith('@')) {
      const from = findLastTriggerIndex(before, '@');
      if (from >= 0) return withReplaceRange(COMPLETIONS_AT, doc, pos, from);
      return COMPLETIONS_AT;
    }

    const last = lastTokenOf(before);
    if (last.startsWith('@Map.')) return COMPLETIONS_MAP_DOT;
    if (last.startsWith('@')) {
      const from = findLastTriggerIndex(before, '@');
      if (from >= 0) return withReplaceRange(COMPLETIONS_AT, doc, pos, from);
      return COMPLETIONS_AT;
    }
    if (last.startsWith('^')) {
      const from = findLastTriggerIndex(before, '^');
      if (from >= 0) return withReplaceRange(COMPLETIONS_CARET, doc, pos, from);
      return COMPLETIONS_CARET;
    }

    return undefined;
  }
};

/* ============================================================
 * Hover (Tooltip)
 *  - CompletionItem.documentation 과 별개
 *  - 마우스 오버 시 문서 표시
 * ============================================================ */

function findMatchAt(text: string, idx: number, re: RegExp): RegExpExecArray | null {
  // re 는 반드시 /g 여야 함
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (idx >= s && idx <= e) return m;
    // 무한 루프 방지
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return null;
}

function extractCaretTokenAt(lineText: string, char: number): { token: string; start: number; end: number } | null {
  // 스캐너 방식: ^ 로 시작하는 메타 토큰을 커서 위치 기준으로 정확히 잡는다.
  // - [] 내부는 어떤 문자(@, +, 공백 등)라도 허용하고, ']' 까지 통째로 포함한다.
  // - 토큰은 공백/콤마/괄호 등에서 끝난다고 가정한다(브라켓 내부 제외).

  // 1) 커서 왼쪽에서 가장 가까운 '^' 후보를 찾되, 그 사이에 공백이 있으면 후보 제외
  for (let start = char; start >= 0; start--) {
    if (lineText[start] !== '^') continue;

    // '^' 와 char 사이에 공백(또는 탭)이 있으면 토큰이 끊긴 것으로 보고 제외
    let hasWs = false;
    for (let k = start + 1; k <= Math.min(char, lineText.length - 1); k++) {
      if (lineText[k] === ' ' || lineText[k] === '\t') {
        hasWs = true;
        break;
      }
    }
    if (hasWs) continue;

    // 2) '^' 다음에는 Data/Class 같은 식별자가 와야 한다
    let i = start + 1;
    if (i >= lineText.length || !/[A-Za-z]/.test(lineText[i])) continue;

    // root ident
    while (i < lineText.length && /[A-Za-z0-9_]/.test(lineText[i])) i++;

    // 3) 나머지 경로 스캔
    let bracketDepth = 0;
    for (; i < lineText.length; i++) {
      const ch = lineText[i];

      if (bracketDepth > 0) {
        // [] 내부는 무엇이든 허용 (단, ']' 만나면 종료)
        if (ch === ']') {
          bracketDepth--;
        }
        continue;
      }

      // bracketDepth === 0
      if (ch === '[') {
        bracketDepth++;
        continue;
      }

      // 프로퍼티 연결
      if (ch === '.') continue;

      // 프로퍼티/키 마커
      if (ch === '!') continue;

      // 다음 식별자(프로퍼티명 등)
      if (/[A-Za-z0-9_]/.test(ch)) continue;

      // 그 외(공백, 괄호, 콤마 등) => 토큰 종료
      break;
    }

    // 토큰 종료 위치: i
    const end = i;
    if (char >= start && char < end) {
      return { token: lineText.slice(start, end), start, end };
    }
  }

  return null;
}

function extractAtWrappedMetaTokenAt(
  lineText: string,
  char: number
): { token: string; start: number; end: number } | null {
  // We must handle nested @...@ inside the outer @Data...@ / @Class...@ token.
  // Example:
  //   @Data.Item[@Get(nVFNewIdx)+1].Name!@
  // Here there is an inner @Get(...)+1@ pair. A naive "first @ after start" fails.

  // 1) Find candidate starts of @Data / @Class up to the cursor.
  const startRe = /@(Data|Class)\b/g;
  const candidates: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(lineText)) !== null) {
    const s = m.index;
    if (s <= char) candidates.push(s);
    if (m.index === startRe.lastIndex) startRe.lastIndex++;
  }
  if (candidates.length === 0) return null;

  // 2) From each candidate start, scan forward to find the matching closing '@'
  //    of the OUTER token. Rule of thumb:
  //    - When inside bracket depth ([...]) we treat @ as nested-pair toggles.
  //    - When bracket depth is 0, the next '@' that would close the token ends it.
  // This matches ABL usage where indices/expressions inside [] often contain @...@.
  function findOuterEnd(start: number): number | null {
    let bracketDepth = 0;
    let inNestedAt = false; // nested @...@ inside the outer token

    for (let i = start + 1; i < lineText.length; i++) {
      const ch = lineText[i];

      if (ch === '[') {
        bracketDepth++;
        continue;
      }
      if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
        continue;
      }

      if (ch === '@') {
        if (bracketDepth > 0) {
          // inside [ ... ]: toggle nested @...@
          inNestedAt = !inNestedAt;
          continue;
        }

        // bracketDepth === 0
        // If we are currently inside a nested @...@ even though bracketDepth is 0,
        // toggle it and continue.
        if (inNestedAt) {
          inNestedAt = false;
          continue;
        }

        // Treat this as the outer closing '@'
        return i;
      }
    }

    return null;
  }

  // 3) Choose the smallest span that contains the cursor.
  let best: { start: number; end: number } | null = null;

  for (let c = candidates.length - 1; c >= 0; c--) {
    const start = candidates[c];
    const end = findOuterEnd(start);
    if (end === null) continue;

    if (char < start || char > end) continue;

    // Validate it's a meta token, not a function call.
    const token = lineText.slice(start, end + 1);

    // Exclude cases like @Data( ... ) (function style)
    const afterName = token.startsWith('@Data') ? token.slice(5) : token.slice(6);
    const afterTrim = afterName.trimStart();
    if (afterTrim.startsWith('(')) continue;

    // Must look like property-ish access
    if (!/[\.\[!]/.test(afterName)) continue;

    const span = { start, end: end + 1 };
    if (!best) {
      best = span;
    } else {
      const bestLen = best.end - best.start;
      const newLen = span.end - span.start;
      if (newLen < bestLen) best = span;
    }
  }

  if (!best) return null;

  const token = lineText.slice(best.start, best.end);
  return { token, start: best.start, end: best.end };
}

function hoverDocForAtWrappedMeta(token: string): string | null {
  // token is like "@Data.Item[@Get(...)+1].Name!@" or "@Class.Name!@"
  // Convert to a pseudo '^' token so we can reuse the same doc mapping logic.

  if (!(token.startsWith('@Data') || token.startsWith('@Class'))) return null;

  // strip wrapping @ ... @
  const inner = token.slice(1, -1); // remove leading '@' and trailing '@'

  // Normalize indices: Item[ ... ] => Item[]
  // Also normalize StringTokenInfo[ ... ] => StringTokenInfo[]
  const normalized = inner
    .replace(/Item\[[^\]]*\]/g, 'Item[]')
    .replace(/StringTokenInfo\[[^\]]*\]/g, 'StringTokenInfo[]');

  // Turn into caret-style path: Data.xxx => ^Data.xxx
  if (normalized.startsWith('Data')) {
    return hoverDocForCaret('^' + normalized);
  }
  if (normalized.startsWith('Class')) {
    return hoverDocForCaret('^' + normalized);
  }

  return null;
}

function hoverDocForCaret(token: string): string | null {
  // ^Data.Item[...].Name! 처럼 실제 인덱스/식이 들어간 경우도 completion 문서 매핑을 위해 정규화한다.
  // Item[무엇이든] => Item[]
  // StringTokenInfo[무엇이든] => StringTokenInfo[]
  const normalizedToken = token
    .replace(/Item\[[^\]]*\]/g, 'Item[]')
    .replace(/StringTokenInfo\[[^\]]*\]/g, 'StringTokenInfo[]');

  // 아래 로직은 normalizedToken 기준으로 판단
  token = normalizedToken;
  // ^Class.Name! / ^Class.Tobe! ...
  if (token.startsWith('^Class.')) {
    const prop = token.replace(/^\^Class\./, '');
    const key = prop.endsWith('!') ? prop : '';
    if (key && CLASS_PROP_DOC[key]) return docFor(`^Class.${key}`, CLASS_PROP_DOC[key]);
    if (token === '^Class.' || token === '^Class') return docFor('^Class.', CLASS_ROOT_DOC);
    return null;
  }

  // ^Data.Count!
  if (token.startsWith('^Data.')) {
    // StringTokenInfo 경로
    if (token.includes('^Data.Item[].StringTokenInfo[]')) {
      // 1) 프로퍼티(예: Name!)
      const key = token.replace(/^\^Data\.Item\[\]\.StringTokenInfo\[\]\./, '');
      if (DATA_STRINGTOKEN_DOC[key]) {
        return docFor(`^Data.Item[].StringTokenInfo[].${key}`, DATA_STRINGTOKEN_DOC[key]);
      }

      // 2) StringTokenInfo[]. 자체
      if (token === '^Data.Item[].StringTokenInfo[].' || token === '^Data.Item[].StringTokenInfo[]') {
        return docFor('^Data.Item[].StringTokenInfo[].', '문자열을 토큰화 시킨 정본');
      }

      return null;
    }

    // Item[] 경로
    if (token.includes('^Data.Item[].')) {
      const key = token.replace(/^\^Data\.Item\[\]\./, '');
      if (DATA_ITEM_DOC[key]) {
        return docFor(`^Data.Item[].${key}`, DATA_ITEM_DOC[key]);
      }
      // Item[]. 자체
      if (token === '^Data.Item[].') {
        return docFor('^Data.Item[].', '현재 토큰에 대한 정보.');
      }
      return null;
    }

    // Root Count!
    const key = token.replace(/^\^Data\./, '');
    if (DATA_ROOT_DOC[key]) return docFor(`^Data.${key}`, DATA_ROOT_DOC[key]);

    // ^Data. 자체
    if (token === '^Data.' || token === '^Data') return docFor('^Data.', '토큰에 대한 정본');

    return null;
  }

  // ^Data / ^Class 루트
  if (token === '^Data') return docFor('^Data.', '토큰에 대한 정본');
  if (token === '^Class') return docFor('^Class.', CLASS_ROOT_DOC);

  return null;
}

const hoverProvider: vscode.HoverProvider = {
  provideHover(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const ch = pos.character;

    // 1) @Function / @End Function
    {
      const reFunc = /@Function\b/g;
      const m = findMatchAt(lineText, ch, reFunc);
      if (m) {
        return new vscode.Hover(
          md(
            `**사용자 정의 함수 선언**\n\n\`\`\`abl\n@Function FUNC_NAME()\n    body\n@End Function\n\`\`\``
          )
        );
      }
    }
    {
      const reEndFunc = /@End\s+Function\b/g;
      const m = findMatchAt(lineText, ch, reEndFunc);
      if (m) {
        return new vscode.Hover(
          md(
            `**사용자 정의 함수 종료**\n\n\`\`\`abl\n@End Function\n\`\`\``
          )
        );
      }
    }

    // 2) ^Data / ^Class 계열 (사전 문서 재사용)
    const caret = extractCaretTokenAt(lineText, ch);
    if (caret) {
      const docText = hoverDocForCaret(caret.token);
      if (docText) {
        return new vscode.Hover(md(docText), new vscode.Range(pos.line, caret.start, pos.line, caret.end));
      }
    }

    // 2-1) @Data...@ / @Class...@ (wrapping '@' 형태의 메타 토큰)
    // 예: @Data.Item[@Get(nVFNewIdx)+1].Name!@
    const atWrapped = extractAtWrappedMetaTokenAt(lineText, ch);
    if (atWrapped) {
      const docText = hoverDocForAtWrappedMeta(atWrapped.token);
      if (docText) {
        return new vscode.Hover(md(docText), new vscode.Range(pos.line, atWrapped.start, pos.line, atWrapped.end));
      }
    }

    // 3) @Map.* (Get/Set/Clear)
    {
      const reMap = /@Map\.(Get|Set|Clear)@?/g;
      const m = findMatchAt(lineText, ch, reMap);
      if (m) {
        const fn = m[1];
        const mapDocs: Record<string, string> = {
          Get: `**Map에 저장된 Key 값 가져오기**\n\n- 인자1: Key\n\n\`\`\`abl\n@Map.Get@(Company_Name@)\n\`\`\``,
          Set: `**Map에 값 저장**\n\n- 인자1: Key\n- 인자2: Value\n\n\`\`\`abl\n@Map.Set@(Company_Name@,ValueAndForce@)\n\`\`\``,
          Clear: `**Map 값 초기화**\n\n\`\`\`abl\n@Map.Clear()\n@Map.Clear(Company_Name)\n@Map.Clear(Company__*)\n\`\`\``
        };
        const body = mapDocs[fn] ?? `\`\`\`abl\n@Map.${fn}\n\`\`\``;
        return new vscode.Hover(md(body));
      }
    }

    // 4) 일반 @함수 (builtin / writer / 사용자)
    //    - 상세 파라미터 문서는 Completion 쪽이 더 풍부하므로 Hover는 "분류" 중심으로 제공
    {
      const reAt = /@([A-Za-z_][A-Za-z0-9_]*)@?/g;
      const m = findMatchAt(lineText, ch, reAt);
      if (m) {
        const name = m[1];
        if (name === 'Map') return undefined; // @Map.은 위에서 처리
        if (AT_CONTROL_WORDS.has(name)) return undefined;

        if (WRITER_KEYWORDS.has(name)) {
          // Completion에서 만든 상세 문서를 Hover에서도 그대로 재사용
          const reused = COMPLETION_DOC_BY_FUNC.get(name);
          if (reused) return new vscode.Hover(reused);

          // fallback
          return new vscode.Hover(
            md(
              `**Writer 함수**\n\n\`\`\`abl\n@${name}(...)\n\`\`\`\n\n> Writer 류는 tmLanguage 색을 유지하도록 Semantic에서 제외되어 있습니다.`
            )
          );
        }

        if (BUILTIN_FUNCTIONS.has(name)) {
          // Completion에서 만든 상세 문서를 Hover에서도 그대로 재사용
          const reused = COMPLETION_DOC_BY_FUNC.get(name);
          if (reused) return new vscode.Hover(reused);

          // fallback
          return new vscode.Hover(md(`**내장 함수**\n\n\`\`\`abl\n@${name}(...)\n\`\`\``));
        }

        return new vscode.Hover(md(`**사용자 정의 함수(미등록 호출로 취급)**\n\n\`\`\`abl\n@${name}(...)\n\`\`\``));
      }
    }

    return undefined;
  }
};

// ============================================================
// Definition Provider
// ============================================================
/**
 * Scan the document for all @Function declarations and return a map of function name to its name-position.
 * - We store the position of the function NAME (not the @Function keyword) for better UX.
 */
function findFunctionDefinitions(doc: vscode.TextDocument): Map<string, vscode.Position> {
  const map = new Map<string, vscode.Position>();
  const re = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i;

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    const m = re.exec(text);
    if (!m) continue;

    const name = m[1];
    const nameIdx = text.indexOf(name);
    map.set(name, new vscode.Position(line, Math.max(0, nameIdx)));
  }

  return map;
}

/**
 * Extract an ABL "@Name" at a position.
 * - Supports: @Foo, @Foo@, @Foo( ... ), @Foo@(
 * - Returns the identifier without the leading '@'.
 */
function getAtIdentAtPosition(doc: vscode.TextDocument, pos: vscode.Position): { name: string; atRange: vscode.Range } | null {
  const lineText = doc.lineAt(pos.line).text;

  // Include '@' in the range so ctrl+click on the '@' also works.
  const range = doc.getWordRangeAtPosition(pos, /@[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) return null;

  const word = doc.getText(range); // like "@Foo"
  if (!word.startsWith('@')) return null;

  const name = word.slice(1);
  if (!name) return null;

  // Exclude @Map.<...>
  const endChar = range.end.character;
  const next = endChar < lineText.length ? lineText[endChar] : '';
  if (name === 'Map' && next === '.') return null;

  return { name, atRange: range };
}

const definitionProvider: vscode.DefinitionProvider = {
  provideDefinition(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const functionMap = findFunctionDefinitions(doc);

    // If we're on a @Function declaration line, jump to the function name on that line.
    {
      const declRe = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i;
      const declMatch = declRe.exec(lineText);
      if (declMatch) {
        const name = declMatch[1];
        const nameIdx = lineText.indexOf(name);
        if (nameIdx >= 0) {
          return new vscode.Location(doc.uri, new vscode.Position(pos.line, nameIdx));
        }
      }
    }

    // If we're on an @Name token, jump to its @Function declaration (user-defined only).
    const at = getAtIdentAtPosition(doc, pos);
    if (!at) return undefined;

    const name = at.name;

    // Control words are not user-defined.
    if (AT_CONTROL_WORDS.has(name)) return undefined;

    // Builtin/writer are not user-defined.
    if (BUILTIN_FUNCTIONS.has(name)) return undefined;
    if (WRITER_KEYWORDS.has(name)) return undefined;

    // Must look like a call: @Name ... '(' (optionally '@' before '(')
    const afterAt = at.atRange.end.character;
    let j = afterAt;
    if (j < lineText.length && lineText[j] === '@') j++;
    while (j < lineText.length && /\s/.test(lineText[j])) j++;
    if (j >= lineText.length || lineText[j] !== '(') return undefined;

    const defPos = functionMap.get(name);
    if (!defPos) return undefined;

    return new vscode.Location(doc.uri, defPos);
  }
};

// ============================================================
// References Provider
// ============================================================
/**
 * Find all references (call sites) of a user-defined function within the current document.
 * - Excludes the declaration line itself: `@Function <name>`
 * - Only treats it as a call if it is followed by an opening paren: @Name( or @Name@( (optionally with whitespace)
 * - Excludes @Map.<...> and comment lines
 */
function findFunctionReferences(doc: vscode.TextDocument, targetName: string): vscode.Location[] {
  const locations: vscode.Location[] = [];

  // Matches: @Name(  OR  @Name@(  (optional whitespace before '(')
  const re = new RegExp(`@${targetName}(?:@)?\\s*\\(`, 'g');

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    // Exclude declaration line: @Function Name
    const declRe = new RegExp(`^\\s*@Function\\s+${targetName}\\b`, 'i');
    if (declRe.test(text)) continue;

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;

      // Defensive: exclude @Map.<...>
      // (e.g., if targetName is 'Map' and the next char is '.', skip)
      const afterNameIdx = start + 1 + targetName.length;
      const afterNameChar = afterNameIdx < text.length ? text[afterNameIdx] : '';
      if (targetName === 'Map' && afterNameChar === '.') {
        if (m.index === re.lastIndex) re.lastIndex++;
        continue;
      }

      // Range should cover @Name or @Name@ (if present)
      let tokenLen = 1 + targetName.length;
      if (afterNameChar === '@') tokenLen++;

      const range = new vscode.Range(line, start, line, start + tokenLen);
      locations.push(new vscode.Location(doc.uri, range));

      // Avoid infinite loops
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return locations;
}

const referencesProvider: vscode.ReferenceProvider = {
  provideReferences(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;

    // 0) If cursor is on a function declaration name: `@Function Name(...)`
    //    Allow Shift+F12 from the bare `Name` (without leading '@').
    {
      const declRe = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i;
      const m = declRe.exec(lineText);
      if (m) {
        const declName = m[1];
        const nameIdx = lineText.indexOf(declName);
        if (nameIdx >= 0) {
          const start = nameIdx;
          const end = nameIdx + declName.length;
          if (pos.character >= start && pos.character <= end) {
            // Only for user-defined functions (exclude accidental collisions)
            if (AT_CONTROL_WORDS.has(declName)) return undefined;
            if (BUILTIN_FUNCTIONS.has(declName)) return undefined;
            if (WRITER_KEYWORDS.has(declName)) return undefined;
            return findFunctionReferences(doc, declName);
          }
        }
      }
    }

    // 1) Normal call-site: cursor on `@Name` token
    const at = getAtIdentAtPosition(doc, pos);
    if (!at) return undefined;

    const name = at.name;

    // Only for user-defined functions
    if (AT_CONTROL_WORDS.has(name)) return undefined;
    if (BUILTIN_FUNCTIONS.has(name)) return undefined;
    if (WRITER_KEYWORDS.has(name)) return undefined;

    return findFunctionReferences(doc, name);
  }
};

// ============================================================
// Rename Symbol (User-defined functions)
// ============================================================

/**
 * Collect all ranges that should be renamed for a given user-defined function.
 * - Declaration: @Function Name(...)
 * - Call sites:  @Name( / @Name@(
 */
function collectRenameRanges(
  doc: vscode.TextDocument,
  name: string
): vscode.Range[] {
  const ranges: vscode.Range[] = [];

  // 1) Declaration
  const declRe = new RegExp(`^\\s*@Function\\s+${name}\\b`, 'i');
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    const m = declRe.exec(text);
    if (m) {
      const idx = text.indexOf(name);
      if (idx >= 0) {
        ranges.push(new vscode.Range(line, idx, line, idx + name.length));
      }
    }
  }

  // 2) Call sites
  const callRe = new RegExp(`@${name}(?:@)?\\s*\\(`, 'g');
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(text)) !== null) {
      const start = m.index + 1; // skip '@'
      ranges.push(new vscode.Range(line, start, line, start + name.length));

      if (m.index === callRe.lastIndex) callRe.lastIndex++;
    }
  }

  return ranges;
}
const renameProvider: vscode.RenameProvider = {
  prepareRename(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;

    // Allow rename from declaration name
    const declRe = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i;
    const m = declRe.exec(lineText);
    if (m) {
      const name = m[1];
      const idx = lineText.indexOf(name);
      if (pos.character >= idx && pos.character <= idx + name.length) {
        if (AT_CONTROL_WORDS.has(name) || BUILTIN_FUNCTIONS.has(name) || WRITER_KEYWORDS.has(name)) {
          throw new Error('이름 변경이 허용되지 않는 함수입니다.');
        }
        return {
          range: new vscode.Range(pos.line, idx, pos.line, idx + name.length),
          placeholder: name
        };
      }
    }

    // Allow rename from call site: @Name
    const at = getAtIdentAtPosition(doc, pos);
    if (!at) return undefined;

    const name = at.name;
    if (AT_CONTROL_WORDS.has(name) || BUILTIN_FUNCTIONS.has(name) || WRITER_KEYWORDS.has(name)) {
      throw new Error('이름 변경이 허용되지 않는 함수입니다.');
    }

    return {
      range: at.atRange,
      placeholder: name
    };
  },

  provideRenameEdits(doc, pos, newName) {
    const workspaceEdit = new vscode.WorkspaceEdit();

    const at = getAtIdentAtPosition(doc, pos);
    let targetName: string | null = null;

    if (at) {
      targetName = at.name;
    } else {
      // maybe from declaration
      const lineText = doc.lineAt(pos.line).text;
      const m = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(lineText);
      if (m) targetName = m[1];
    }

    if (!targetName) return workspaceEdit;

    if (AT_CONTROL_WORDS.has(targetName) || BUILTIN_FUNCTIONS.has(targetName) || WRITER_KEYWORDS.has(targetName)) {
      return workspaceEdit;
    }

    const ranges = collectRenameRanges(doc, targetName);
    for (const r of ranges) {
      workspaceEdit.replace(doc.uri, r, newName);
    }

    return workspaceEdit;
  }
};

/* ============================================================
 * Folding (Code Folding)
 *  - @Function ~ @End Function
 *  - @If ~ @End If
 *  - @For ~ @End For
 * ============================================================ */

type FoldKind = 'function' | 'if' | 'for';

type FoldFrame = {
  kind: FoldKind;
  startLine: number;
};

function provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
  if (doc.languageId !== 'abl') return [];

  const ranges: vscode.FoldingRange[] = [];
  const stack: FoldFrame[] = [];

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    // ----- Starts -----
    if (/^\s*@Function\b/i.test(text)) {
      stack.push({ kind: 'function', startLine: line });
      continue;
    }

    // @If 만 블록 시작으로 취급 (@Else If / @Else 는 같은 블록 내부로 포함)
    // - 중첩 If는 @If / @End If 스택으로 정상 처리됨
    if (/^\s*@If\b/i.test(text)) {
      stack.push({ kind: 'if', startLine: line });
      continue;
    }

    if (/^\s*@For\b/i.test(text)) {
      stack.push({ kind: 'for', startLine: line });
      continue;
    }

    // ----- Ends -----
    if (/^\s*@End\s+Function\b/i.test(text)) {
      // 최근 function start를 찾아 매칭
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind !== 'function') continue;
        const start = stack[i].startLine;
        stack.splice(i, 1);

        // Start~End 사이 최소 1라인 이상일 때만 folding
        if (line > start) {
          ranges.push(new vscode.FoldingRange(start, line));
        }
        break;
      }
      continue;
    }

    if (/^\s*@End\s+If\b/i.test(text)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind !== 'if') continue;
        const start = stack[i].startLine;
        stack.splice(i, 1);
        if (line > start) {
          ranges.push(new vscode.FoldingRange(start, line));
        }
        break;
      }
      continue;
    }

    if (/^\s*@End\s+For\b/i.test(text)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind !== 'for') continue;
        const start = stack[i].startLine;
        stack.splice(i, 1);
        if (line > start) {
          ranges.push(new vscode.FoldingRange(start, line));
        }
        break;
      }
      continue;
    }
  }

  // 정렬(선택): VS Code가 알아서 처리하긴 하지만, 안정성을 위해 start 기준 정렬
  ranges.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return ranges;
}


const foldingProvider: vscode.FoldingRangeProvider = {
  provideFoldingRanges(doc) {
    return provideFoldingRanges(doc);
  }
};

// ============================================================
// Document Symbols (Outline)
// - Show user-defined functions in the VS Code OUTLINE view
//   (Ctrl+Shift+O / Cmd+Shift+O)
// ============================================================

type FuncFrame = {
  name: string;
  startLine: number;
  nameRange: vscode.Range;
};

function findFunctionBlocks(doc: vscode.TextDocument): Array<{ name: string; range: vscode.Range; selectionRange: vscode.Range }> {
  const blocks: Array<{ name: string; range: vscode.Range; selectionRange: vscode.Range }> = [];
  const stack: FuncFrame[] = [];

  const reStart = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)/i;
  const reEnd = /^\s*@End\s+Function\b/i;

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    const m = reStart.exec(text);
    if (m) {
      const name = m[1];
      const idx = text.indexOf(name);
      const nameStart = Math.max(0, idx);
      const nameEnd = nameStart + name.length;

      stack.push({
        name,
        startLine: line,
        nameRange: new vscode.Range(line, nameStart, line, nameEnd)
      });
      continue;
    }

    if (reEnd.test(text)) {
      const frame = stack.pop();
      if (!frame) continue;

      const startLineText = doc.lineAt(frame.startLine).text;
      const endLineText = doc.lineAt(line).text;

      const range = new vscode.Range(
        frame.startLine,
        0,
        line,
        endLineText.length
      );

      blocks.push({
        name: frame.name,
        range,
        selectionRange: frame.nameRange
      });
      continue;
    }
  }

  // Unclosed @Function blocks: still show in outline (range to EOF)
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const lastLine = Math.max(0, doc.lineCount - 1);
    const lastText = doc.lineAt(lastLine).text;
    const range = new vscode.Range(frame.startLine, 0, lastLine, lastText.length);
    blocks.push({
      name: frame.name,
      range,
      selectionRange: frame.nameRange
    });
  }

  // Keep stable order by start position
  blocks.sort((a, b) => (a.range.start.line - b.range.start.line) || (a.range.start.character - b.range.start.character));
  return blocks;
}

const documentSymbolProvider: vscode.DocumentSymbolProvider = {
  provideDocumentSymbols(doc) {
    if (doc.languageId !== 'abl') return [];

    const symbols: vscode.DocumentSymbol[] = [];
    const blocks = findFunctionBlocks(doc);

    for (const b of blocks) {
      const sym = new vscode.DocumentSymbol(
        b.name,
        '@Function',
        vscode.SymbolKind.Function,
        b.range,
        b.selectionRange
      );
      symbols.push(sym);
    }

    return symbols;
  }
};

/* ============================================================
 * Semantic Tokens
 * ============================================================ */

/** "@Name" 뒤에 "(" 가 실제로 이어지는지(호출인지) 확인 */
function getCallParenIndex(lineText: string, startAt: number, nameLen: number): number | null {
  // startAt: '@' 위치
  let j = startAt + 1 + nameLen;

  // @Name@(...) 형태 지원: 이름 바로 뒤 @ 허용(공백은 보수적으로 허용하지 않음)
  if (j < lineText.length && lineText[j] === '@') j++;

  while (j < lineText.length && /\s/.test(lineText[j])) j++;
  if (j < lineText.length && lineText[j] === '(') return j;

  return null;
}

function provideTokens(doc: vscode.TextDocument): vscode.SemanticTokens {
  const builder = new vscode.SemanticTokensBuilder(legend);

  userFunctions.clear();

  const lineToFunc = buildFuncLineMap(doc);
  const funcNameById = buildFuncNameMap(doc);

  for (let line = 0; line < doc.lineCount; line++) {
    const lineText = doc.lineAt(line).text;
    const baseOffset = doc.offsetAt(new vscode.Position(line, 0));

    const funcId = lineToFunc[line];
    const currentFuncName = funcId >= 0 ? funcNameById.get(funcId) : undefined;

    // 문자열 내부는 제외하고 검사(진단과 동일한 전략)
    const scanText = stripSingleQuoted2(lineText);

    // ✅ 함수 내부에서 @Set <함수명> / @Get(<함수명>) 만 ablReturn로 칠함
    if (currentFuncName) {
      // @Set ASDF
      const setRe = /@Set\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
      for (let m; (m = setRe.exec(scanText)); ) {
        const name = m[1];
        if (name === currentFuncName) {
          const start = m.index + m[0].lastIndexOf(name);
          pushToken(builder, doc, baseOffset + start, name.length, 'ablReturn');
        }
      }

      // @Get(ASDF)
      const getRe = /@Get\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
      for (let m; (m = getRe.exec(scanText)); ) {
        const name = m[1];
        if (name === currentFuncName) {
          const whole = m[0];
          const namePosInWhole = whole.indexOf(name);
          const start = m.index + namePosInWhole;
          pushToken(builder, doc, baseOffset + start, name.length, 'ablReturn');
        }
      }
    }

    const stack: Frame[] = [];
    let ifMode = false;
    let ifParenDepth = 0;
    let inSingleQuote = false;

    const mapName = /@Map\.(Get|Set|Clear)@?/y;

    const top = () => (stack.length ? stack[stack.length - 1] : undefined);

    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];

      /* =========================
       * ✅ @Function / @End Function
       * ========================= */

      if (lineText.startsWith('@Function', i) && isWordBoundary(lineText, i, 9)) {
        pushToken(builder, doc, baseOffset + i, 9, 'ablFunctionDecl');

        const mm = /@Function\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText.slice(i));
        if (mm) {
          const fn = mm[1];
          userFunctions.add(fn);

          const fullMatched = mm[0];
          const nameIdxInFull = fullMatched.indexOf(fn);
          const fnPos = i + nameIdxInFull;

          pushToken(builder, doc, baseOffset + fnPos, fn.length, 'ablReturn');
        }
      }

      if (lineText.startsWith('@End Function', i) && isWordBoundary(lineText, i, 13)) {
        pushToken(builder, doc, baseOffset + i, 13, 'ablFunctionEnd');
      }

      /* =========================
       * ✅ ^Data / ^Class (원본 유지)
       * ========================= */
      if (ch === '^') {
        if (lineText.startsWith('^Data', i)) {
          pushToken(builder, doc, baseOffset + i, 5, 'ablData');
          continue;
        }
        if (lineText.startsWith('^Class', i)) {
          pushToken(builder, doc, baseOffset + i, 6, 'ablData');
          continue;
        }
      }

      if (inSingleQuote) continue;

      /* =========================
       * ✅ 연산자 하이라이트 (원본 유지)
       * ========================= */
      if (ch === '+' || ch === '=') {
        const prev = i > 0 ? lineText[i - 1] : '';
        const next = i + 1 < lineText.length ? lineText[i + 1] : '';

        if (
          (ch === '=' && (prev === '>' || prev === '<' || prev === '!' || prev === '=')) ||
          (ch === '=' && next === '=')
        ) {
          // skip
        } else {
          pushToken(builder, doc, baseOffset + i, 1, 'ablLogic');
        }
      }

      /* =========================
       * ✅ ^Data.* / ^Class.* 전체 구간 (원본 유지)
       * ========================= */
      if (ch === '^' && (lineText.startsWith('^Data', i) || lineText.startsWith('^Class', i))) {
        let j = i + 1;

        while (j < lineText.length && /[A-Za-z0-9_]/.test(lineText[j])) j++;

        while (j < lineText.length) {
          const c = lineText[j];

          if (c === '.') {
            j++;
            while (j < lineText.length && /[A-Za-z0-9_]/.test(lineText[j])) j++;
            continue;
          }

          if (c === '[') {
            j++;
            while (j < lineText.length && lineText[j] !== ']') j++;
            if (j < lineText.length && lineText[j] === ']') j++;
            continue;
          }

          if (c === '!') {
            j++;
            continue;
          }

          break;
        }

        pushToken(builder, doc, baseOffset + i, j - i, 'ablFunc');
        i = j - 1;
        continue;
      }

      /* =========================
       * ✅ If / ElseIf mode (원본 유지)
       * ========================= */
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

      /* =========================
       * ✅ Map context (원본 유지)
       * ========================= */
      mapName.lastIndex = i;
      const mm2 = mapName.exec(lineText);
      if (mm2) {
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

      /* ============================================================
       * ✅ 핵심: @Something(...) 를 "선언 위치 무관"하게 분류
       *  - KNOWN_FUNCTIONS => ablFunc
       *  - 그 외 => ablFunctionCall
       *  - 둘 다 stack에 넣어서 내부 @ / 끝 @ 색칠 유지
       * ============================================================ */
      if (ch === '@') {
        const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText.slice(i));
        if (m) {
          const name = m[1];

          // @Map. 은 별도 처리(여기서 건드리지 않음)
          const afterName = lineText[i + 1 + name.length] ?? '';
          if (name === 'Map' && afterName === '.') {
            // skip
          } else if (AT_CONTROL_WORDS.has(name)) {
            // skip
          } else if (WRITER_KEYWORDS.has(name)) {
            // tmLanguage 색 유지 (semantic 덮어쓰기 방지)
        } else {
            const parenIdx = getCallParenIndex(lineText, i, name.length);
            if (parenIdx !== null) {
              // 토큰 길이: "@Name" 또는 "@Name@" 까지만
              let tokenLen = 1 + name.length;
              if (lineText[i + tokenLen] === '@') tokenLen++;

              const kind: CtxKind = BUILTIN_FUNCTIONS.has(name) ? 'ablFunc' : 'ablFunctionCall';
              pushToken(builder, doc, baseOffset + i, tokenLen, kind);
              stack.push({ kind, depth: 1 });

              i = parenIdx;
            continue;
            }
          }
        }
      }

      /* =========================
       * ✅ Inner @ (stack 기반, 원본 유지)
       * ========================= */
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

      /* =========================
       * ✅ Depth tracking (원본 유지)
       * ========================= */
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
 * Diagnostic (If + For)  (원본 유지)
 * ============================================================ */

const diag = vscode.languages.createDiagnosticCollection('abl');

// ============================================================
// Diagnostics: Undeclared variables for @Get/@Set inside @Function blocks
// - Rule: within @Function ~ @End Function, every variable used in @Get(x) / @Set(x, ...) must be declared
//         using @String / @Int / @Boolean (extensible). Declaration may appear anywhere inside the block.
// - We only validate simple identifiers (e.g., nCount). Expressions/literals are ignored.
// ============================================================

// === REPLACEMENT: Strict @String/@Int declaration and @Get/@Set diagnostics ===
type VarType = 'String' | 'Int';
const VAR_DECL_TYPES: ReadonlyArray<VarType> = ['String', 'Int'] as const;

function stripSingleQuoted(text: string): string {
  // Remove single-quoted spans so regex diagnostics won't match inside strings.
  // Handles doubled quotes '' inside strings.
  let out = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      const next = text[i + 1];
      if (inQ) {
        if (next === "'") {
          // escaped quote inside string
          i++;
          continue;
        }
        inQ = false;
        continue;
      } else {
        if (next === "'") {
          // empty literal '' outside string
          i++;
          continue;
        }
        inQ = true;
        continue;
      }
    }
    if (!inQ) out += ch;
  }
  return out;
}

function isSimpleIdent(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/* ============================================================
 * Undeclared variable diagnostics (Global vs Function scope)
 * 규칙:
 *  - Function 밖: 전역 선언만 유효
 *  - Function 안: (전역 선언 + 해당 Function의 로컬 선언) 유효
 *  - 로컬 선언 변수는 Function 밖에서 쓰이면 오류
 * ============================================================ */

const varDiag = vscode.languages.createDiagnosticCollection('abl-vars');

// 선언 패턴 (전역/로컬 공통)
const declRe = /^\s*@(String|Int)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;

// 사용 패턴 (최소한으로: @Set x , @Get(x))
const setUseRe = /@Set\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
const getUseRe = /@Get\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;

// Function 블록 시작/끝 (너희 룰 파일 기준으로 맞춰둠)
const fnStartRe = /^\s*@Function\b/i;
const fnEndRe = /^\s*@End\s+Function\b/i;

// Function 이름 저장
const fnNameRe = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|$)/i;

// 주석 라인
function isCommentLine2(text: string) {
  return /^[ \t]*#/.test(text);
}

// 문자열 제거(단일따옴표) — 정교 파싱 말고 보수적으로만(기존 너의 전략과 동일 결)
function stripSingleQuoted2(line: string): string {
  // '' 는 escape로 보고 유지, 그 외는 '...'(라인 내)만 공백으로 마스킹
  let out = '';
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const next = line[i + 1];
      if (inQ) {
        if (next === "'") {
          // '' inside string
          out += "  ";
          i++;
          continue;
        } else {
          inQ = false;
          out += ' ';
          continue;
        }
      } else {
        if (next === "'") {
          // '' outside string
          out += "  ";
          i++;
          continue;
        } else {
          inQ = true;
          out += ' ';
          continue;
        }
      }
    }
    out += inQ ? ' ' : ch;
  }

  return out;
}

// 각 라인이 어떤 Function에 속하는지 매핑 (없으면 -1)
function buildFuncLineMap(doc: vscode.TextDocument): number[] {
  const lineToFunc = new Array<number>(doc.lineCount).fill(-1);

  let funcIdx = -1;
  let inFunc = false;

  for (let line = 0; line < doc.lineCount; line++) {
    const raw = doc.lineAt(line).text;
    if (fnStartRe.test(raw)) {
      funcIdx++;
      inFunc = true;
      lineToFunc[line] = funcIdx;
      continue;
    }
    if (inFunc) lineToFunc[line] = funcIdx;
    if (fnEndRe.test(raw)) {
      // End Function 라인도 해당 함수로 취급
      inFunc = false;
    }
  }

  return lineToFunc;
}

function buildFuncNameMap(doc: vscode.TextDocument): Map<number, string> {
  const map = new Map<number, string>();

  let funcIdx = -1;

  for (let line = 0; line < doc.lineCount; line++) {
    const raw = doc.lineAt(line).text;

    if (fnStartRe.test(raw)) {
      funcIdx++;

      const mm = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|$)/i.exec(raw);
      if (mm) {
        map.set(funcIdx, mm[1]);
      }
    }
  }

  return map;
}

function provideUndeclaredVarDiagnostics(doc: vscode.TextDocument) {
  if (doc.languageId !== 'abl') return;

  const diagnostics: vscode.Diagnostic[] = [];
  const lineToFunc = buildFuncLineMap(doc);

  // “지금까지 선언된” 기준으로 에러를 내기 위해 top-down 누적
  const globalDeclared = new Set<string>();
  const localDeclaredByFunc = new Map<number, Set<string>>();

  const getLocalSet = (funcId: number) => {
    let s = localDeclaredByFunc.get(funcId);
    if (!s) {
      s = new Set<string>();
      localDeclaredByFunc.set(funcId, s);
    }
    return s;
  };

  for (let line = 0; line < doc.lineCount; line++) {
    const raw = doc.lineAt(line).text;
    if (!raw.trim()) continue;
    if (isCommentLine2(raw)) continue;

    const funcId = lineToFunc[line]; // -1이면 전역

    // 문자열 마스킹 후 검사 (문자열 안 @Set/@Get 방지)
    const text = stripSingleQuoted2(raw);

    // ✅ 0) @Function 라인 처리: 함수명은 "리턴 변수"로 암묵 선언 처리
    const fm = fnNameRe.exec(text);
    if (fm) {
      const funcName = fm[1];

      // buildFuncLineMap상 @Function 라인은 funcId가 -1이 아니어야 정상
      if (funcId !== -1) {
        getLocalSet(funcId).add(funcName);
      }

      // 함수 선언 라인에서는 추가 사용검사 불필요
      continue;
    }

    // 1) 선언 처리
    const dm = declRe.exec(text);
    if (dm) {
      const varName = dm[2];

      if (funcId === -1) {
        globalDeclared.add(varName);
      } else {
        getLocalSet(funcId).add(varName);
      }
      continue; // 선언 라인에서는 사용검사를 굳이 하지 않음
    }

    // 2) 사용 처리 (@Set, @Get)
    const allowedInThisLine = (name: string) => {
      if (funcId === -1) {
        // 전역: 전역 선언만 허용
        return globalDeclared.has(name);
      } else {
        // 함수 안: 로컬 + 전역 허용
        const local = getLocalSet(funcId);
        return local.has(name) || globalDeclared.has(name);
      }
    };

    // @Set x
    setUseRe.lastIndex = 0;
    for (let m; (m = setUseRe.exec(text)); ) {
      const name = m[1];
      if (!allowedInThisLine(name)) {
        const start = m.index + m[0].lastIndexOf(name);
        const end = start + name.length;
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, start, line, end),
            funcId === -1
              ? `전역 영역에서 선언되지 않은 변수입니다: ${name}`
              : `Function/전역 어디에도 선언되지 않은 변수입니다: ${name}`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }

    // @Get(name)
    getUseRe.lastIndex = 0;
    for (let m; (m = getUseRe.exec(text)); ) {
      const name = m[1];
      if (!allowedInThisLine(name)) {
        // 괄호 안 name 위치 찾기(대충 맞춰도 됨)
        const whole = m[0];
        const namePosInWhole = whole.indexOf(name);
        const start = m.index + namePosInWhole;
        const end = start + name.length;

        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, start, line, end),
            funcId === -1
              ? `전역 영역에서 선언되지 않은 변수입니다: ${name}`
              : `Function/전역 어디에도 선언되지 않은 변수입니다: ${name}`,
            vscode.DiagnosticSeverity.Error
          )
        );
      }
    }
  }

  varDiag.set(doc.uri, diagnostics);
}

function isQuotedOperandOk(op: string): boolean {
  const t = stripOuterParens(op).trim();
  if (!t.startsWith("'")) return true;
  return t.endsWith("'");
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
  const funcStack: number[] = [];

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

    // ---- Function diagnostics ----
    if (/^\s*@Function\b/i.test(text)) {
      funcStack.push(line);
      continue;
    }

    if (/^\s*@End\s+Function\b/i.test(text)) {
      if (funcStack.length === 0) {
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(line, 0, line, text.length),
            '@End Function 에 대응되는 @Function 이 없습니다.',
            vscode.DiagnosticSeverity.Error
          )
        );
      } else {
        funcStack.pop();
      }
      continue;
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

  for (const line of funcStack) {
    diagnostics.push(
      new vscode.Diagnostic(
        new vscode.Range(line, 0, line, doc.lineAt(line).text.length),
        '@Function 에 대응되는 @End Function 이 없습니다.',
        vscode.DiagnosticSeverity.Error
      )
    );
  }

  // Undeclared variable check for @Get/@Set within @Function blocks
  //provideUndeclaredVarDiagnostics(doc, diagnostics);

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
 * Formatter (Document Formatting)
 *  - 블록 구조(@If/@Else/@End If, @For/@End For, @Function/@End Function) 기준 indent 재계산
 *  - (옵션) @If/@Else If 라인의 @Then 앞 공백을 1개로 정규화
 * ============================================================ */
function normalizeThenSpacing(content: string): string {
  // Only normalize when the line contains @Then. We must ignore @Then inside single quotes.
  if (!/@Then\b/i.test(content)) return content;

  let inQ = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === "'") {
      const next = content[i + 1];
      if (inQ) {
        if (next === "'") {
          i++; // escaped '' inside string
          continue;
        }
        inQ = false;
        continue;
      } else {
        if (next === "'") {
          i++; // empty literal '' outside string
          continue;
        }
        inQ = true;
        continue;
      }
    }
    if (inQ) continue;

    // Find the first @Then outside quotes.
    if ((content[i] === '@' || content[i] === '＠') && content.slice(i).match(/^@Then\b/i)) {
      // Collapse any whitespace immediately before '@Then' to exactly one space.
      // Determine how far back the whitespace run goes.
      let j = i - 1;
      while (j >= 0 && (content[j] === ' ' || content[j] === '\t')) j--;

      // If there was at least one whitespace char, replace that run with a single space.
      // If there was none (e.g., "...')@Then"), we still insert a single space.
      const before = content.slice(0, j + 1);
      const after = content.slice(i);
      return before + ' ' + after;
    }
  }

  return content;
}

const formatterProvider: vscode.DocumentFormattingEditProvider = {
  provideDocumentFormattingEdits(doc) {
    if (doc.languageId !== 'abl') return [];

    const edits: vscode.TextEdit[] = [];
    let indentLevel = 0;

    for (let line = 0; line < doc.lineCount; line++) {
      const textLine = doc.lineAt(line);
      const raw = textLine.text;

      if (!raw.trim() || isCommentLine(raw)) continue;

      const trimmed = raw.trim();

      // ---- outdent 먼저 적용되는 라인 ----
      if (/^@(End\s+(If|For|Function)|Else(\s+If)?\b)/i.test(trimmed)) {
        indentLevel = Math.max(0, indentLevel - 1);
      }

      const expectedIndent = '\t'.repeat(indentLevel);
      const currentIndentMatch = raw.match(/^[\t ]*/)?.[0] ?? '';
      const content = raw.slice(currentIndentMatch.length);

      // ---- (옵션) @Then 앞 공백 1개 정규화 ----
      // 대상: @If ... @Then, @Else If ... @Then
      let normalizedContent = content;
      if (/^@If\b/i.test(trimmed) || /^@Else\s+If\b/i.test(trimmed)) {
        normalizedContent = normalizeThenSpacing(content);
      }

      const desiredLine = expectedIndent + normalizedContent;

      if (desiredLine !== raw) {
        edits.push(
          vscode.TextEdit.replace(
            new vscode.Range(line, 0, line, raw.length),
            desiredLine
          )
        );
      }

      // ---- 다음 줄부터 indent 증가 ----
      if (
        /^@(If\b.*@Then\b|Else\s+If\b.*@Then\b|Else\b|For\b|Function\b)/i.test(trimmed)
      ) {
        indentLevel++;
      }
    }

    return edits;
  }
};

/* ============================================================
 * Extension lifecycle
 * ============================================================ */
export function activate(context: vscode.ExtensionContext) {
  // Diagnostic collections
  context.subscriptions.push(diag);
  context.subscriptions.push(varDiag);

  // ---------------------------------------------------------------------------
  // Language configuration (Indentation Rules)
  // ---------------------------------------------------------------------------
  context.subscriptions.push(
    vscode.languages.setLanguageConfiguration('abl', {
      indentationRules: {
        // 다음 라인에 indent가 한 단계 증가해야 하는 패턴
        // - @If ... @Then
        // - @Else If ... @Then
        // - @Else
        // - @For
        // - @Function
        increaseIndentPattern:
          /^\t|^\s*@(?:(?:If\b.*@Then\b)|(?:Else\s+If\b.*@Then\b)|(?:Else\b)|(?:For\b)|(?:Function\b))/i,

        // 현재 라인이 outdent(감소)되어야 하는 패턴
        // - @End If / @End For / @End Function
        // - @Else / @Else If
        decreaseIndentPattern:
          /^\s*@(?:(?:End\s+(?:If|For|Function)\b)|(?:Else\b)|(?:Else\s+If\b))/i
      },

      // 엔터 입력 시 다음 라인의 액션
      onEnterRules: [
        { beforeText: /^\s*@If\b.*@Then\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Else\s+If\b.*@Then\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Else\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@For\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Function\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } }
      ]
    })
  );

  // Outdent only the current line(s) after completion acceptance.
  context.subscriptions.push(
    vscode.commands.registerCommand('abl.outdentCurrentLine', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const prevSelections = editor.selections.map(s => new vscode.Selection(s.start, s.end));

      const lineSelections = editor.selections.map(sel => {
        const line = sel.active.line;
        const text = doc.lineAt(line).text;
        return new vscode.Selection(line, 0, line, text.length);
      });

      try {
        editor.selections = lineSelections;
        await vscode.commands.executeCommand('editor.action.outdentLines');
      } finally {
        editor.selections = prevSelections;
      }
    })
  );

  // Semantic tokens
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'abl' },
      { provideDocumentSemanticTokens: provideTokens },
      legend
    )
  );

  // Diagnostics
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      provideIfDiagnostics(doc);
      provideUndeclaredVarDiagnostics(doc);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      provideIfDiagnostics(e.document);
      provideUndeclaredVarDiagnostics(e.document);
    })
  );

  if (vscode.window.activeTextEditor) {
    provideIfDiagnostics(vscode.window.activeTextEditor.document);
    provideUndeclaredVarDiagnostics(vscode.window.activeTextEditor.document);
  }

  // Language features
  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'abl' }, hoverProvider));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'abl' }, definitionProvider));
  context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: 'abl' }, referencesProvider));
  context.subscriptions.push(vscode.languages.registerRenameProvider({ language: 'abl' }, renameProvider));
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider({ language: 'abl' }, foldingProvider));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: 'abl' }, documentSymbolProvider));

  // Formatter
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'abl' }, formatterProvider)
  );

  // Completion
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'abl' }, completionProvider, '@', '^', '.')
  );
}


export function deactivate() {}