import * as vscode from 'vscode';
import { exec } from 'child_process';

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
  ['ablMap', 'ablFunc', 'ablLogic', 'ablOperator', 'ablData', 'ablFunctionDecl', 'ablFunctionEnd', 'ablFunctionCall', 'ablReturn'],
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
  | 'ablOperator'
  | 'ablData'
  | 'ablFunctionDecl'
  | 'ablFunctionEnd'
  | 'ablFunctionCall'
  | 'ablReturn';

/**
 * 함수 목록 단일 소스
 * - kind: 'builtin' => semantic에서 ablFunc로 칠함
 * - kind: 'writer'  => completion은 제공해도 semantic은 tmLanguage에 맡김(덮어쓰기 방지)
 */
type BuiltinKind = 'builtin' | 'writer' | 'getset';
const FUNCTION_META: ReadonlyArray<{ name: string; kind: BuiltinKind }> = [
  // Functions
  { name: 'Get', kind: 'getset' },
  { name: 'Set', kind: 'getset' },
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
  { name: 'DisplayLog', kind: 'builtin' },
  { name: 'StrToken', kind: 'builtin' },
  { name: 'SetStrToken', kind: 'builtin' },
  { name: 'GetStrToken', kind: 'builtin' },
  { name: 'GetStrTokens', kind: 'builtin' },
  { name: 'StrAllToken', kind: 'builtin' },

  // ABL Keyword
  { name: 'ABL', kind: 'builtin' },

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
const GET_SET_KEYWORDS = new Set<string>(FUNCTION_META.filter(f => f.kind === 'getset').map(f => f.name));

/**
 * 미리 등록한(내장) 함수들
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
  'Function'
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

function hasUnclosedSingleQuoteABL(s: string): boolean {
  let inQ = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "'") continue;

    const next = s[i + 1];
    const next2 = s[i + 2];

    if (!inQ) {
      // DSL 특수 케이스: "'@" 정상 처리
      if (next === '@') {
        const after = s[i + 2] ?? '';
        if (after === ',' || after === ')' || after === ' ' || after === '\t' || after === '') {
          i += 1;
          continue;
        }
      }
      // ''' : 단일 따옴표 문자 리터럴(정상)
      if (next === "'" && next2 === "'") {
        i += 2;
        continue;
      }
      // '' : 빈 문자열(정상) 또는 단순 2연속(정상)
      if (next === "'") {
        i += 1;
        continue;
      }
      // 문자열 시작
      inQ = true;
      continue;
    } else {
      // 문자열 내부에서 '' 는 escape 따옴표 문자
      if (next === "'") {
        // ''' : ''(따옴표 문자) + '(닫기)
        if (next2 === "'") {
          i += 2;
          inQ = false;
          continue;
        }
        i += 1;
        continue;
      }
      // 문자열 종료
      inQ = false;
      continue;
    }
  }

  return inQ;
}

/* ============================================================
 * Completion (IntelliSense)
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
  ciSnippet('@ABL', '@ABL(\'${1:find_rule}\')', 'ABL', `**ABL 범위 찾기**\n\n- 인자1: ABL 정규 표현식\n\n\`\`\`abl\n# if( ... ) 범위 잡아오기\n@ABL('if([%])')\n\`\`\``),
  ciSnippet(
    '@Function()',
    '@Function ${1:Function_Name}()\n\t#----------------------------------------------------------------------------\n\t# Variables\n\t#----------------------------------------------------------------------------\n\t#\n\t# Boolean Variable\n\t#\n\t# String Variable\n\t#\n\t# Int Variable\n\t#\n\t# Initialize Variable\n\t#----------------------------------------------------------------------------\n\t# Main Logic\n\t#----------------------------------------------------------------------------\n@End Function',
    'Function',
    `**사용자 정의 함수**\n\n- 예:\n\`\`\`abl\n- 파리미터 없으면:\n@Function FUNC_NAME()\n    body\n@End Function\n\`\`\`\n\n- 파라미터가 있으면:\n\`\`\`abl\n@Function FUNC_NAME(pParam1,pParam2)\n    body\n@End Function\n\`\`\``
  ),
  (() => {
    const item = ciKeyword('@End Function', '@End Function', 'Function', `**사용자 정의 함수 종료**\n\n\`\`\`abl\n@End Function\n\`\`\``);
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
  ciSnippet('@String', '@String s${1:name}', 'String', `**String 변수 선언**\n\n- 인자1: 변수명\n\n\`\`\`abl\n# sText 변수 선언\n@String sText\n\`\`\``),
  ciSnippet('@String', '@String o${1:name}', 'Boolean', `**Boolean 변수 선언**\n\n- 인자1: 변수명\n\n\`\`\`abl\n# oFlag 변수 선언\n@String oFlag\n\`\`\``),
  ciSnippet('@Int', '@Int n${1:name}', 'Int', `**Int 변수 선언**\n\n- 인자1: 변수명\n\n\`\`\`abl\n# nNum 변수 선언\n@Int nNum\n\`\`\``),
  ciSnippet('@Set', '@Set ${1:variable} = ${2:result}', 'Set', `**변수에 값 할당**\n\n- 인자1: 변수명\n- 설정값: 값\n\n\`\`\`abl\n# myVar 변수에 100 저장\n@Set myVar = 100\n\`\`\``),
  ciSnippet('@Get()', '@Get(${1:variable})', 'Get', `**변수 값 가져오기**\n\n- 인자1: 변수명\n\n\`\`\`abl\n# myVar 변수 값 가져오기\n@Get(myVar)\n\`\`\``),
  ciSnippet('@Map.Set@(@,@)','@Map.Set@(${1:key}@,${2:value}@)','Map', `**Map에 값 저장**\n\n- 인자1: Key\n- 인자2: Value\n\n\`\`\`abl\n# Company_Name 이라는 Key 값에 ValueAndForce라는 값 저장\n@Map.Set@(Company_Name@,ValueAndForce@)\n\`\`\``),
  ciSnippet('@Map.Get@(@)','@Map.Get@(${1:key}@)','Map', `**Map에 저장된 Key 값 가져오기**\n\n- 인자1: Key\n\n\`\`\`abl\n# ValueAndForce 값 가져요가\n@Map.Get@(Company_Name@)\n\`\`\``),
  ciSnippet('@Map.Clear()','@Map.Clear(${1:key})','Map', `**Map 값 초기화**\n예:\n\`\`\`abl\n# 저장된 모든 Map 값 삭제\n@Map.Clear()\n\n# Company_Name 이라는 Key 값 삭제\n@Map.Clear(Company_Name)\n\n# Company_ 가 Key인 모든 Map 값 삭제 (구분자 : _*)\n@Map.Clear(Company__*)\n\`\`\``),
  ciSnippet('@If ... @Then ... @End If','@If ${1:condition} @Then\n\t${2:statememt}\n@End If','Control', `**If 조건문**\n\n\`\`\`abl\n@If condition @Then\n    statememt\n@End If\n\`\`\``),
  (() => {
    const item = ciSnippet('@Else If ... @Then','@Else If ${1:condition} @Then','Control', `**Else If 조건문**\n\n\`\`\`abl\n@Else If condition @Then\n    statement\n\`\`\``);
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
  ciKeyword('@Then', '@Then', 'Control'),
  ciSnippet('@For ... @End For','@For %${1:index} ${2:start} : ${3:end}\n\t${4:statememt}\n@End For','Loop', `**For 반복문**\n\n\`\`\`abl\n@For condition\n  statement\n@End For\`\`\``),
  (() => {
    const item = ciKeyword('@End For', '@End For', 'Loop', `For문 종료\`\`abl\n@End For\n\`\`\``);
    item.command = { title: 'Outdent Current Line', command: 'abl.outdentCurrentLine' };
    return item;
  })(),
  ciSnippet('@Break', '@Break', 'Control', `**For 문을 즉시 빠져나오는 제어문**\n\n\`\`\`abl\n@Break\n\`\`\``),
  ciSnippet('@Continue', '@Continue', 'Control', `**반복문에서 나머지 코드 건너뛰고 다음 반복으로 즉시 넘어가는 제어문**\n\n\`\`\`abl\n@Continue\n\`\`\``),
  ciSnippet('@UpperCase@(@)', '@UpperCase@(${1:string}@)', 'Function', `**대문자로 변환**\n\n- 인자1 : 문자열\n\n\`\`\`abl\n#aaaa -> AAAA\n@UpperCase@(aaaa@)\n\`\`\``),
  ciSnippet('@LowerCase@(@)', '@LowerCase@(${1:string}@)', 'Function', `**소문자로 변환**\n\n- 인자1 : 문자열\n\n\`\`\`abl\n#AAAA -> aaaa\n@UpperCase@(AAAA@)\n\`\`\``),
  ciSnippet('@SubString@(@,@,@)', '@SubString@(${1:string}@,${2:position}@,${3:length}@)', 'Function', `**문자열의 시작 위치부터 길이 만큼 출력**\n\n- 인자1 : 문자열\n- 인자2 : 시작 위치\n- 인자3 : 길이\n\`\`\`abl\n#abcdefg -> bcd\n@SubString@(abcdefg@,2@,3@)\n\`\`\``),
  ciSnippet('@Replace@(@,@,@)', '@Replace@(${1:string}@,${2:before}@,${3:after}@)', 'Function', `**문자 대체**\n\n- 인자1 : 문자열\n- 인자2 : 대체할 문자열\n- 인자3 : 치환 문자열\n\n\`\`\`abl\n#abcdefg -> a123efg\n@Replace@(abcdefg@,bcd@,123@)\n\`\`\``),
  ciSnippet('@Length@(@)', '@Length@(${1:string}@)', 'Function', `**문자열 길이**\n\n- 인자1 : 문자열\n\n\`\`\`abl\n#なるほうど -> 5\n@Length@(なるほうど@)\n\`\`\``),
  ciSnippet('@LengthB@(@)', '@LengthB@(${1:string}@)', 'Function', `**문자열의 Byte 길이**\n\n- 인자1 : 문자열\n\n\`\`\`abl\n#なるほうど -> 10\n@LengthB@(なるほうど@)\n\`\`\``),
  ciSnippet('@Pos@(@,@)', '@Pos@(${1:find}@,${2:string}@)', 'Function', `**문자열 내의 문자열의 위치**\n\n- 인자1 : 찾을 문자열\n- 인자2 : 문자열\n\n\`\`\`abl\n#abcdefg 에서 bcd의 위치 -> 2\n@Pos@(bcd@abcdefg@)\n\`\`\``),
  ciSnippet('@FilePath()', '@FilePath()', 'Function', `**전환하는 프로그램의 파일 경로**\n\n\`\`\`abl\n#\\src\\java\\main\n@FilePath()\n\`\`\``),
  ciSnippet('@Trim@(@)', '@Trim@(${1:string}@)', 'Function', `**문자열 앞/뒤의 불필요한 공백 제거**\n\n- 인자1 : 문자열\n\n\`\`\`abl\n# abcdefg -> abcdefg\n@Trim@( abcdefg@)\n\`\`\``),
  ciSnippet('@DisplayLog()', '@DisplayLog(${1:statement})', 'Function', `**문자열 앞/뒤의 불필요한 공백 제거**\n\n- 인자1 : 로그로 표시할 문장\n\n\`\`\`abl\n@DisplayLog(This is a log message)\n\`\`\``),
  ciSnippet('@Naming@(@,@)', '@Naming@(${1:string}@,${2:option}@)', 'Function', `**Naming 규칙에 맞게 문자열 변경**\n\n- 인자1 : 문자열\n- 인자2 : 옵션\n\n\`\`\`abl\n# First : 첫문자 대분자, 나머지 소문자\n# AAA_BBB_CCC -> Aaa_bbb_ccc\n@Naming@(AAA_BBB_CCC@,First@)\n\n# UpperCase : 모든 문자 대문자\n# aaa_bbb_ccc -> AAA_BBB_CCC\n@Naming@(aaa_bbb_ccc@,UpperCase@)\n\n# LowerCase : 모든 문자 소문자\n# AAA_BBB_CCC -> aaa_bbb_ccc\n@Naming@(AAA_BBB_CCC@,LowerCase@)\n\n# FirstLower : 첫 문자만 소문자, 나머지 그대로\n# AAA_BBB_CCC -> aAA_BBB_CCC\n@Naming@(AAA_BBB_CCC@,FirstLower@)\n\n# FirstUpper : 첫 문자만 대문자, 나머지 그대로\n# aaa_bbb_ccc -> Aaa_bbb_ccc\n@Naming@(aaa_bbb_ccc@,FirstUpper@)\n\n# Hungarian : _ 기준으로 처음 오는 문자만 대문자, 나머지는 소문자\n# AAA_BBB_CCC -> aaaBbbCcc\n@Naming@(AAA_BBB_CCC@,Hungarian@)\n\n# Camel : _ 기준 첫 단어의 첫 글자만 소문자, 나머지는 Hungarian\n# AAA_BBB_CCC -> aAABbbCcc\n@Naming@(AAA_BBB_CCC@,Camel@)\n\n# Pascal : 첫글자 대문자, 나머지는 Hungarian 처리\n# AAA_BBB_CCC -> AAABbbCcc\n@Naming@(AAA_BBB_CCC@,Pascal@)\n\`\`\``),
  ciSnippet('@SysDateTime()', '@SysDateTime()', 'Function', `**현재 시스템 날짜 및 시간 출력**\n\n- 인자1 : 날짜 및 시간 출력 형식\n\n\`\`\`abl\n# 2026-01-01 09:00:05\n@SysDateTime(YYYY-MM-DD HH:MM:SS)\n\n# 2026/01/01\n@SysDateTime(YYYY/MM/DD)\n\`\`\``),
  ciSnippet('@GetTabSpace()', '@GetTabSpace()', 'Function', `**Tab 개수 만큼의 공백을 줌**\n\n- 인자1 : Tab 개수\n\n\`\`\`abl\n# Tab 1\n@GetTabSpace(1)A ->     A\n\n# Tab 2\n@GetTabSpace(2)A ->         A\n\`\`\``),
  ciSnippet('@GetSpace()', '@GetSpace()', 'Function', `**공백 개수 만큼의 공백을 줌**\n\n- 인자1 : 공백 개수\n\n\`\`\`abl\n# 공백 1개\n@GetSpace(1)A ->  A\n\n# 공백 3개\n@GetSpace(3)A ->    A\n\`\`\``),
  ciSnippet('@GetTokenSpace()', '@GetTokenSpace()', 'Function', `**토큰의 공백과 탭 개수 만큼 공백과 탭을 줌**\n\n- 인자1 : Tab 개수\n- 인자2 : 공백 개수\n\n\`\`\`abl\n# Tab 1 , 공백 2\n@GetTokenSpace(1,2)A ->       A\n\`\`\``),
  ciSnippet('@Prespace()', '@Prespace(${1:token}) = ${2:spaces}', 'Function', `**해당 토큰 앞에 space 추가**\n\n- 인자1 : 토큰 넘버\n- 설정값 : 공백 개수 \n\n\`\`\`abl\n# if(a>b) -> if( a>b)\n@Prespace(3) = 1\n\`\`\``),
  ciSnippet('@Pretab()', '@Pretab(${1:token}) = ${2:tabs}', 'Function', `**해당 토큰 앞에 tab 추가**\n\n- 인자1 : 토큰 넘버\n- 설정값 : Tab 개수 \n\n\`\`\`abl\n# if(a>b) -> if(    a>b)\n@Pretab(3) = 1\n\`\`\``),
  ciSnippet('@Space()', '@Space(${1:token}) = ${2:spaces}', 'Function', `**해당 토큰 뒤에 space 를 변경**\n\n- 인자1 : 토큰 넘버\n- 설정값 : space 개수 \n\n\`\`\`abl\n# if(a>b) -> if(a >b)\n@Space(3) = 1\n\`\`\``),
  ciSnippet('@StrToken@(@,@)', '@StrToken@(${1:string}@,${2:token}@)', 'String Token', `**문자열을 token을 기준으로 토큰화**\n\n- 인자1 : 토큰화 할 문자열\n- 인자2 : 구분자로 사용할 토큰 \n\n\`\`\`abl\n# A|B|C|D|E -> A B C D E \n@StrToken@(A|B|C|D|E@,|@)\n\`\`\``),
  ciSnippet('@StrAllToken@(@,@)', '@StrAllToken@(${1:string}@,${2:token}@)', 'String Token', `**문자열을 token을 기준으로 구분자 까지 포함하여 토큰화**\n\n- 인자1 : 토큰화 할 문자열\n- 인자2 : 구분자로 사용할 토큰 \n\n\`\`\`abl\n# A|B|C|D|E -> A | B | C | D | E \n@StrAllToken@(A|B|C|D|E@,|@)\n\`\`\``),
  ciSnippet('@GetStrToken@(@)', '@GetStrToken@(${1:option}@)', 'String Token', `**StrToken의 값을 option에 따라 가지고 옴**\n\n- 인자1 : 옵션\n\n\`\`\`abl\n# Count : 토큰화된 토큰의 개수\n# @StrToken@(A|B|C@,|@) 일 때\n# @GetStrToken@(Count@) -> 3\n# @StrAllToken@(A|B|C@,|@) 일 때\n# @GetStrToken@(Count@) -> 5\n@GetStrToken@(Count@)\n\n# All : 저장된 문자열 가지고 오기\n# @StrToken@(A|B|C@,|@) 일 때 \n# @GetStrToken@(All@) -> A|B|C\n# @StrAllToken@(A|B|C@,|@) 일 때\n# @GetStrToken@(All@) -> A|B|C\n@GetStrToken@(All@)\n\n# index : 토큰화된 n 번째 토큰 가지고 오기\n# @StrToken@(A|B|C@,|@) 일 때\n# @GetStrToken@(2@) -> B\n# @StrAllToken@(A|B|C@,|@) 일 때\n# @GetStrToken@(2@) -> |\n@GetStrToken@(2@)\n\`\`\``),
  ciSnippet('@GetStrToken@(All@,@)', '@GetStrToken@(All@,${1:token}@)', 'String Token', `**StrToken의 구분자 변경**\n\n- 인자1 : All 고정\n- 인자2 : 변경할 구분자로 사용할 토큰\n\n\`\`\`abl\n# Count : 토큰화된 토큰의 개수\n# A|B|C -> A_B_C\n@GetStrToken@(All@,_@)\n\`\`\``),
  ciSnippet('@GetStrTokens@(@,@)', '@GetStrTokens@(${1:start}@,${2:end}@)', 'String Token', `**StrToken으로 토크닝된 값을 범위로 가지고 옴**\n\n- 인자1 : 시작 인덱스\n- 인자2 : 끝 인덱스\n\n\`\`\`abl\n# Count : 토큰화된 토큰의 개수\n# A|B|C|D|E -> B|C|D\n@GetStrTokens@(2@,4@)\n\`\`\``),
  ciSnippet('@GetStrTokens@(@,@,@)', '@GetStrTokens@(${1:start}@,${2:end}@,${3:token}@)', 'String Token', `**StrToken으로 토크닝된 값을 범위로 가지고 오고 구분 토큰 변경*\n\n- 인자1 : 시작 인덱스\n- 인자2 : 끝 인덱스\n- 인자3 : 변경할 구분자로 사용할 토큰\n\n\`\`\`abl\n# Count : 토큰화된 토큰의 개수\n# A|B|C|D|E -> B_C_D\n@GetStrTokens@(2@,4@,_@)\n\`\`\``),
  ciSnippet('@SetStrToken@(@,@)', '@SetStrTokens@(${1:index}@,${2:token}@)', 'String Token', `**StrToken의 토큰 값 변경*\n\n- 인자1 : 변경할 인덱스\n- 인자2 : 변경할 문자열\n\n\`\`\`abl\n# Count : 토큰화된 토큰의 개수\n# A|B|C|D|E -> A|X|C|D|E\n@SetStrToken@(2@,X@)\n\`\`\``),
  ciSnippet('@SetQueryClear()', '@SetQueryClear()', 'DB Function', `**쿼리 문장 초기화** \n\n\`\`\`abl\n@SetQueryClear()\n\`\`\``),
  ciSnippet('@SetQueryAdd@(@)', '@SetQueryAdd@(${1:query}@)', 'DB Function', `**쿼리 문장 추가** \n\n- 인자1 : 쿼리문\n\n\`\`\`abl\n@SetQueryAdd@(@Get(sQuery)@)\n\`\`\``),
  ciSnippet('@GetSelectQueryResult()', '@GetSelectQueryResult()', 'DB Function', `**Select문의 결과 값 1개 가져오기** \n\n\`\`\`abl\n@GetSelectQueryResult()\n\`\`\``),
  ciSnippet('@QueryExecution()', '@QueryExecution()', 'DB Function', `**Insert, Update, Delete 실행** \n\n\`\`\`abl\n@QueryExecution()\n\`\`\``),
  ciSnippet('@QueryResultToMap()', '@QueryResultToMap()', 'DB Function', `**다중 Select 값 가져와서 Map에 저장** \n\n\`\`\`abl\n@QueryResultToMap()\n\`\`\``),
  ciSnippet('@Data()', '@Data(${1:token}) =${2:result}', 'Writer', `**토큰 자리에 값 출력** \n\n- 인자1 : 토큰 넘버\n- 설정값 : 결과\n\n\`\`\`abl\n# if(a>b) -> if(d>b)\n@Data(3) = d\n\`\`\``),
  ciSnippet('@Base()', '@Base(${1:token}) =${2:result}', 'Writer', `**다른 전환룰에 의해 전환되는걸 방지** \n\n- 인자1 : 토큰 넘버\n- 설정값 : 결과\n\n\`\`\`abl\n@Base(3) = AA\n\`\`\``),
  ciSnippet('@AddLine()', '@AddLine(${1:token}) =${2:result}', 'Writer', `**토큰의 뒤에 라인 추가** \n\n- 인자1 : 토큰 넘버\n- 설정값 : 결과\n\n\`\`\`abl\n# if(a>b)\n@AddLine(3) = addedLine\n# if(a\n# addedLine\n# >b)\n\`\`\``),
  ciSnippet('@InsertLine()', '@InsertLine(${1:token}) =${2:result}', 'Writer', `**토큰의 앞에 라인 추가** \n\n- 인자1 : 토큰 넘버\n- 설정값 : 결과\n\n\`\`\`abl\n# if(a>b)\n@InsertLine(3) = insertedLine\n# if(\n# insertedLine\n# a>b)\n\`\`\``),
  ciSnippet('@AddLinePrespace()', '@AddLinePrespace(${1:token},${2:spaces}) =${3:result}', 'Writer', `**토큰의 뒤에 라인 추가 및 공백 추가** \n\n- 인자1 : 토큰 넘버\n- 인자2 : 공백 개수\n- 설정값 : 결과\n\n\`\`\`abl\n# if(a>b)\n@AddLine(3,2) = addedLine\n# if(a\n#   addedLine\n# >b)\n\`\`\``),
  ciSnippet('@InsertLinePrespace()', '@InsertLinePrespace(${1:token},${2:spaces}) =${3:result}', 'Writer', `**토큰의 앞에 라인 추가 및 공백 추가**\n\n- 인자1 : 토큰 넘버\n- 인자2 : 공백 개수\n- 설정값 : 결과\n\n\`\`\`abl\n# if(a>b)\n@InsertLine(3,3) = insertedLine\n# if(\n#    insertedLine\n# a>b)\n\`\`\``),
  ciSnippet('@GenerationCreateFile()', '@GenerationCreateFile(${1:abl file name}) = ${2:file path}, ${3:file name}, ${4:extension}, ${5:utf-8}', 'Create File', `**파일 생성하기** \n\n- 인자1 : abl 파일 이름\n- 설정값1 : 파일 경로\n- 설정값2 : 파일 이름\n- 설정값3 : 파일 확장자\n- 설정값4 : utf-8 (생략 가능)\n\n\`\`\`abl\n@GenerationCreateFile(test.abl) = src\\java\\main, TestFile, java\n\n@GenerationCreateFile(test.abl) = src\\java\\main, TestFile, java, utf-8\n\`\`\``),
  ciSnippet('@Tobe_File_Path()', '@Tobe_File_Path(${1:file path})', 'File Path', `**전환 후 파일의 생성 경로** \n\n- 인자1 : 파일의 경로\n\n\`\`\`abl\n@Tobe_File_Path(src\\java\\main)\n\`\`\``),
  ciSnippet('@Tobe_File_Name()', '@Tobe_File_Name(${1:file name})', 'File Name', `**전환 후 파일의 이름** \n\n- 인자1 : 파일의 이름\n\n\`\`\`abl\n@Tobe_File_Name(NewFile.java)\n\`\`\``),
];

function labelToString(label: vscode.CompletionItemLabel | string): string {
  return typeof label === 'string' ? label : label.label;
}

function extractAtNameFromLabel(label: string): string | null {
  if (!label.startsWith('@')) return null;
  if (label.startsWith('@Map.')) return null;

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

for (const it of COMPLETIONS_AT) {
  const doc = it.documentation;
  if (!doc) continue;

  const label = labelToString(it.label);
  const name = extractAtNameFromLabel(label);
  if (!name) continue;

  if (AT_CONTROL_WORDS.has(name)) continue;

  if (doc instanceof vscode.MarkdownString) {
    COMPLETION_DOC_BY_FUNC.set(name, doc);
  } else {
    COMPLETION_DOC_BY_FUNC.set(name, md(String(doc)));
  }
}

const COMPLETIONS_MAP_DOT: vscode.CompletionItem[] = [
  ciSnippet('Get','Get@(${1:key}@)','Map', `**Map에 저장된 Key 값 가져오기**\n\n- 인자1: Key\n\n\`\`\`abl\n# ValueAndForce 값 가져요가\n@Map.Get@(Company_Name@)\n\`\`\``),
  ciSnippet('Set','Set@(${1:key}@,${2:value}@)','Map', `**Map에 값 저장**\n\n- 인자1: Key\n- 인자2: Value\n\n\`\`\`abl\n# Company_Name 이라는 Key 값에 ValueAndForce라는 값 저장\n@Map.Set@(Company_Name@,ValueAndForce@)\n\`\`\``),
  ciSnippet('Clear','Clear()','Map', `**Map 값 초기화**\n예:\n\`\`\`abl\n# 저장된 모든 Map 값 삭제\n@Map.Clear()\n\n# Company_Name 이라는 Key 값 삭제\n@Map.Clear(Company_Name)\n\n# Company_ 가 Key인 모든 Map 값 삭제 (구분자 : _*)\n@Map.Clear(Company__*)\n\`\`\``)
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

const CLASS_PROPS = ['Name!', 'Tobe!', 'Package!', 'Extends!'];
const DATA_ROOT_SUFFIXES = ['Count!', 'Item[].']; 

const DATA_ITEM_PROPS = [
  'Name!', 'Tobe!', 'Type!', 'TobeType!', 'Length!', 'NewLine!', 'Line!',
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!'
];

const DATA_STRINGTOKEN_PROPS = [
  'Name!', 'Tobe!', 'Type!', 'TobeType!', 'Length!', 'NewLine!', 'Line!',
  'Block_Level!', 'Level!', 'Format!', 'Prespace!', 'Pretab!', 'Column!'
];

function docFor(full: string, extra?: string) {
  return `\n\`\`\`abl\n${full}\n\`\`\`\n${extra ? `\n${extra}\n` : ''}\n`;
}

const DOT_CLASS_ITEMS = makeDotSuffixItems(
  '^Class.',
  CLASS_PROPS,
  '^Class',
  (full) => {
    const sfx = full.replace('^Class.', '');
    return docFor(full, CLASS_PROP_DOC[sfx]);
  }
);

const DOT_DATA_ITEMS = [
  ...makeDotSuffixItems(
    '^Data.',
    ['Count!'],
    '^Data',
    (full) => {
      const sfx = full.replace('^Data.', '');
      return docFor(full, DATA_ROOT_DOC[sfx]);
    }
  ),
  ...makeDotSuffixItems(
    '^Data.',
    ['Item[].'],
    '^Data',
    (full) => docFor(full, '현재 토큰에 대한 정보.'),
    true 
  ),
];

const DOT_DATA_ITEM_BASE = makeDotSuffixItems(
  '^Data.Item[].',
  DATA_ITEM_PROPS,
  '^Data.Item[]',
  (full) => {
    const sfx = full.replace('^Data.Item[].', '');
    return docFor(full, DATA_ITEM_DOC[sfx]);
  }
);

function extendDataItemDotItems(base: vscode.CompletionItem[]): vscode.CompletionItem[] {
  const stringToken = ciProperty(
    'StringTokenInfo[].',
    'StringTokenInfo[].',
    '^Data.Item[]',
    docFor('^Data.Item[].StringTokenInfo[].', '문자열을 토큰화 시킨 정보')
  );

  stringToken.command = {
    title: 'Trigger Suggest',
    command: 'editor.action.triggerSuggest'
  };

  return [stringToken, ...base];
}

const DOT_DATA_ITEM_ITEMS = extendDataItemDotItems(DOT_DATA_ITEM_BASE);

const DOT_DATA_STRINGTOKEN_ITEMS = makeDotSuffixItems(
  '^Data.Item[].StringTokenInfo[].',
  DATA_STRINGTOKEN_PROPS,
  '^Data.StringTokenInfo[]',
  (full) => {
    const sfx = full.replace('^Data.Item[].StringTokenInfo[].', '');
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
  if (/\^Data\.Item\[[^\]]*\]\.StringTokenInfo(\[[^\]]*\])?\.\s*$/.test(s)) return 'dataStringToken';
  if (/\^Data\.Item\[[^\]]*\]\.\s*$/.test(s)) return 'dataItem';
  if (/\^Data\.\s*$/.test(s)) return 'data';
  if (/\^Class\.\s*$/.test(s)) return 'class';
  return null;
}

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

function buildDeclaredVarItemsAt(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] {
  const declReLocal = /^\s*@(String|Int)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
  const fnStartReLocal = /^\s*@Function\b/i;
  const fnEndReLocal = /^\s*@End\s+Function\b/i;
  const fnNameReLocal = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|$)/i;
  const fnParamsReLocal = /^\s*@Function\b.*?\(([^)]*)\)/i;

  const lineToFunc = buildFuncLineMap(doc);
  const curFuncId = lineToFunc[pos.line];

  const globalDeclared = new Set<string>();
  const localDeclared = new Set<string>();

  for (let line = 0; line <= pos.line; line++) {
    let raw = doc.lineAt(line).text;
    if (line === pos.line) raw = raw.slice(0, pos.character);

    if (!raw.trim()) continue;
    if (isCommentLine(raw)) continue;

    const funcId = lineToFunc[line]; 

    if (fnStartReLocal.test(raw)) {
      const fm = fnNameReLocal.exec(raw);
      if (fm && funcId !== -1 && funcId === curFuncId) {
        localDeclared.add(fm[1]);

        const pm = fnParamsReLocal.exec(raw);
        const params = pm?.[1]?.trim();
        if (params) {
          for (const token of params.split(',')) {
            const name = token.trim();
            if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) localDeclared.add(name);
          }
        }
      }
      continue;
    }

    if (fnEndReLocal.test(raw)) continue;

    const dm = declReLocal.exec(raw);
    if (dm) {
      const varName = dm[2];
      if (funcId === -1) {
        globalDeclared.add(varName);
      } else if (funcId === curFuncId) {
        localDeclared.add(varName);
      }
      continue;
    }
  }

  const merged = new Set<string>();
  if (curFuncId === -1) {
    for (const v of globalDeclared) merged.add(v);
  } else {
    for (const v of globalDeclared) merged.add(v);
    for (const v of localDeclared) merged.add(v);
  }

  const items: vscode.CompletionItem[] = [];
  for (const name of Array.from(merged).sort((a, b) => a.localeCompare(b))) {
    const it = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
    it.detail = curFuncId === -1 ? 'Global Variable' : (localDeclared.has(name) ? 'Local Variable' : 'Global Variable');
    it.sortText = `a_var_${name.toLowerCase()}`;
    it.insertText = name;
    items.push(it);
  }

  return items;
}

function findLastTriggerIndex(before: string, trigger: '@' | '^'): number {
  return before.lastIndexOf(trigger);
}

type UserFuncInfo = { name: string; params?: string; line: number };
const USER_FUNCS_BY_DOC = new Map<string, UserFuncInfo[]>();

function buildParamSnippet(params?: string): string {
  if (!params) return '';
  const names = params
    .split(',')
    .map(p => p.trim())
    .filter(p => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p));

  return names.map((name, i) => `\${${i + 1}:${name}}`).join(', ');
}

function indexUserFunctions(doc: vscode.TextDocument) {
  if (doc.languageId !== 'abl') return;

  const list: UserFuncInfo[] = [];
  const seen = new Set<string>();

  for (let line = 0; line < doc.lineCount; line++) {
    const raw = doc.lineAt(line).text;
    if (!raw.trim()) continue;
    if (isCommentLine(raw)) continue;

    const text = maskStringLiterals(raw);

    fnNameRe.lastIndex = 0;
    const fm = fnNameRe.exec(text);
    if (!fm) continue;

    const name = fm[1];
    if (seen.has(name)) continue;
    seen.add(name);

    fnParamsRe.lastIndex = 0;
    const pm = fnParamsRe.exec(text);
    const params = pm?.[1]?.trim();

    list.push({ name, params, line });
  }

  USER_FUNCS_BY_DOC.set(doc.uri.toString(), list);
}

function buildUserFuncCompletionItems(doc: vscode.TextDocument): vscode.CompletionItem[] {
  const key = doc.uri.toString();
  const funcs = USER_FUNCS_BY_DOC.get(key) ?? [];

  const items: vscode.CompletionItem[] = [];
  for (const f of funcs) {
    const label = `@${f.name}`;
    const it = new vscode.CompletionItem(label, vscode.CompletionItemKind.Function);

    const paramSnippet = buildParamSnippet(f.params);
    it.insertText = new vscode.SnippetString(`@${f.name}(${paramSnippet})$0`);
    it.detail = 'User Function';
    it.documentation = md(
      `**${label}** (User Function)\n\n` +
      (f.params ? `**Params:** \`${f.params}\`\n\n` : '') +
      `\`\`\`abl\n@${f.name}(${f.params ?? ''})\n\`\`\`\n`
    );
    it.sortText = `z_user_${f.name.toLowerCase()}`;

    items.push(it);
  }

  return items;
}

function completionsAtWithUserFunctions(doc: vscode.TextDocument): vscode.CompletionItem[] {
  if (!USER_FUNCS_BY_DOC.has(doc.uri.toString())) indexUserFunctions(doc);
  const user = buildUserFuncCompletionItems(doc);
  return [...COMPLETIONS_AT, ...user];
}

const completionProvider: vscode.CompletionItemProvider = {
  provideCompletionItems(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const before = lineText.slice(0, pos.character);

    {
      const m = /@Get\s*\(\s*([A-Za-z0-9_]*)$/i.exec(before);
      if (m) {
        const prefix = m[1] ?? '';
        const replaceFromChar = pos.character - prefix.length;
        const vars = buildDeclaredVarItemsAt(doc, pos);
        return withReplaceRange(vars, doc, pos, replaceFromChar);
      }
    }

    {
      const m = /@Set\s+([A-Za-z0-9_]*)$/i.exec(before);
      if (m) {
        const prefix = m[1] ?? '';
        const replaceFromChar = pos.character - prefix.length;
        const vars = buildDeclaredVarItemsAt(doc, pos);
        return withReplaceRange(vars, doc, pos, replaceFromChar);
      }
    }

    if (before.endsWith('.')) {
      if (/@Map\.\s*$/.test(before)) return COMPLETIONS_MAP_DOT;

      const ctx = getDotContext(before);
      if (ctx === 'class') return DOT_CLASS_ITEMS;
      if (ctx === 'data') return DOT_DATA_ITEMS;
      if (ctx === 'dataItem') return DOT_DATA_ITEM_ITEMS;
      if (ctx === 'dataStringToken') return DOT_DATA_STRINGTOKEN_ITEMS;
      return undefined;
    }

    {
      const lastDot = before.lastIndexOf('.');
      if (lastDot >= 0) {
        const replaceFromChar = lastDot + 1; 

        if (/@Map\.[A-Za-z0-9_]*\s*$/.test(before)) {
          return withReplaceRange(COMPLETIONS_MAP_DOT, doc, pos, replaceFromChar);
        }
        if (/\^Class\.[A-Za-z0-9_]*\s*$/.test(before)) {
          return withReplaceRange(DOT_CLASS_ITEMS, doc, pos, replaceFromChar);
        }
        if (/\^Data\.[A-Za-z0-9_]*\s*$/.test(before)) {
          return withReplaceRange(DOT_DATA_ITEMS, doc, pos, replaceFromChar);
        }
        if (/\^Data\.Item\[[^\]]*\]\.[A-Za-z0-9_]*\s*$/.test(before)) {
          return withReplaceRange(DOT_DATA_ITEM_ITEMS, doc, pos, replaceFromChar);
        }
        if (/\^Data\.Item\[[^\]]*\]\.StringTokenInfo(\[[^\]]*\])?\.[A-Za-z0-9_]*\s*$/.test(before)) {
          return withReplaceRange(DOT_DATA_STRINGTOKEN_ITEMS, doc, pos, replaceFromChar);
        }
      }
    }

    if (before.endsWith('^')) {
      const from = findLastTriggerIndex(before, '^');
      if (from >= 0) return withReplaceRange(COMPLETIONS_CARET, doc, pos, from);
      return COMPLETIONS_CARET;
    }
    if (before.endsWith('@')) {
      const from = findLastTriggerIndex(before, '@');
      const items = completionsAtWithUserFunctions(doc);
      if (from >= 0) return withReplaceRange(items, doc, pos, from);
      return items;
    }

    const last = lastTokenOf(before);
    if (last.startsWith('@Map.')) return COMPLETIONS_MAP_DOT;

    if (last.startsWith('@') && !/@Set\s+[A-Za-z0-9_]*$/.test(before)) {
      const from = findLastTriggerIndex(before, '@');
      const items = completionsAtWithUserFunctions(doc);
      if (from >= 0) return withReplaceRange(items, doc, pos, from);
      return items;
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
 * ============================================================ */

function findMatchAt(text: string, idx: number, re: RegExp): RegExpExecArray | null {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m.index;
    const e = s + m[0].length;
    if (idx >= s && idx <= e) return m;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return null;
}

function extractCaretTokenAt(lineText: string, char: number): { token: string; start: number; end: number } | null {
  for (let start = char; start >= 0; start--) {
    if (lineText[start] !== '^') continue;

    let hasWs = false;
    for (let k = start + 1; k <= Math.min(char, lineText.length - 1); k++) {
      if (lineText[k] === ' ' || lineText[k] === '\t') {
        hasWs = true;
        break;
      }
    }
    if (hasWs) continue;

    let i = start + 1;
    if (i >= lineText.length || !/[A-Za-z]/.test(lineText[i])) continue;

    while (i < lineText.length && /[A-Za-z0-9_]/.test(lineText[i])) i++;

    let bracketDepth = 0;
    for (; i < lineText.length; i++) {
      const ch = lineText[i];
      if (bracketDepth > 0) {
        if (ch === ']') bracketDepth--;
        continue;
      }
      if (ch === '[') {
        bracketDepth++;
        continue;
      }
      if (ch === '.') continue;
      if (ch === '!') continue;
      if (/[A-Za-z0-9_]/.test(ch)) continue;
      break;
    }

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
  const startRe = /@(Data|Class)\b/g;
  const candidates: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(lineText)) !== null) {
    const s = m.index;
    if (s <= char) candidates.push(s);
    if (m.index === startRe.lastIndex) startRe.lastIndex++;
  }
  if (candidates.length === 0) return null;

  function findOuterEnd(start: number): number | null {
    let bracketDepth = 0;
    let inNestedAt = false; 

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
          inNestedAt = !inNestedAt;
          continue;
        }

        if (inNestedAt) {
          inNestedAt = false;
          continue;
        }
        return i;
      }
    }
    return null;
  }

  let best: { start: number; end: number } | null = null;

  for (let c = candidates.length - 1; c >= 0; c--) {
    const start = candidates[c];
    const end = findOuterEnd(start);
    if (end === null) continue;

    if (char < start || char > end) continue;

    const token = lineText.slice(start, end + 1);
    const afterName = token.startsWith('@Data') ? token.slice(5) : token.slice(6);
    const afterTrim = afterName.trimStart();
    if (afterTrim.startsWith('(')) continue;

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
  if (!(token.startsWith('@Data') || token.startsWith('@Class'))) return null;

  const inner = token.slice(1, -1); 
  const normalized = inner
    .replace(/Item\[[^\]]*\]/g, 'Item[]')
    .replace(/StringTokenInfo\[[^\]]*\]/g, 'StringTokenInfo[]');

  if (normalized.startsWith('Data')) return hoverDocForCaret('^' + normalized);
  if (normalized.startsWith('Class')) return hoverDocForCaret('^' + normalized);

  return null;
}

function hoverDocForCaret(token: string): string | null {
  const normalizedToken = token
    .replace(/Item\[[^\]]*\]/g, 'Item[]')
    .replace(/StringTokenInfo\[[^\]]*\]/g, 'StringTokenInfo[]');

  token = normalizedToken;
  if (token.startsWith('^Class.')) {
    const prop = token.replace(/^\^Class\./, '');
    const key = prop.endsWith('!') ? prop : '';
    if (key && CLASS_PROP_DOC[key]) return docFor(`^Class.${key}`, CLASS_PROP_DOC[key]);
    if (token === '^Class.' || token === '^Class') return docFor('^Class.', CLASS_ROOT_DOC);
    return null;
  }

  if (token.startsWith('^Data.')) {
    if (token.includes('^Data.Item[].StringTokenInfo[]')) {
      const key = token.replace(/^\^Data\.Item\[\]\.StringTokenInfo\[\]\./, '');
      if (DATA_STRINGTOKEN_DOC[key]) {
        return docFor(`^Data.Item[].StringTokenInfo[].${key}`, DATA_STRINGTOKEN_DOC[key]);
      }
      if (token === '^Data.Item[].StringTokenInfo[].' || token === '^Data.Item[].StringTokenInfo[]') {
        return docFor('^Data.Item[].StringTokenInfo[].', '문자열을 토큰화 시킨 정보');
      }
      return null;
    }

    if (token.includes('^Data.Item[].')) {
      const key = token.replace(/^\^Data\.Item\[\]\./, '');
      if (DATA_ITEM_DOC[key]) {
        return docFor(`^Data.Item[].${key}`, DATA_ITEM_DOC[key]);
      }
      if (token === '^Data.Item[].') {
        return docFor('^Data.Item[].', '현재 토큰에 대한 정보.');
      }
      return null;
    }

    const key = token.replace(/^\^Data\./, '');
    if (DATA_ROOT_DOC[key]) return docFor(`^Data.${key}`, DATA_ROOT_DOC[key]);

    if (token === '^Data.' || token === '^Data') return docFor('^Data.', '토큰에 대한 정보');
    return null;
  }

  if (token === '^Data') return docFor('^Data.', '토큰에 대한 정보');
  if (token === '^Class') return docFor('^Class.', CLASS_ROOT_DOC);

  return null;
}

const hoverProvider: vscode.HoverProvider = {
  provideHover(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;
    const ch = pos.character;

    {
      const reFunc = /@Function\b/g;
      const m = findMatchAt(lineText, ch, reFunc);
      if (m) {
        return new vscode.Hover(md(`**사용자 정의 함수 선언**\n\n\`\`\`abl\n@Function FUNC_NAME()\n\tbody\n@End Function\n\`\`\``));
      }
    }
    {
      const reEndFunc = /@End\s+Function\b/g;
      const m = findMatchAt(lineText, ch, reEndFunc);
      if (m) {
        return new vscode.Hover(md(`**사용자 정의 함수 종료**\n\n\`\`\`abl\n@End Function\n\`\`\``));
      }
    }

    const caret = extractCaretTokenAt(lineText, ch);
    if (caret) {
      const docText = hoverDocForCaret(caret.token);
      if (docText) {
        return new vscode.Hover(md(docText), new vscode.Range(pos.line, caret.start, pos.line, caret.end));
      }
    }

    const atWrapped = extractAtWrappedMetaTokenAt(lineText, ch);
    if (atWrapped) {
      const docText = hoverDocForAtWrappedMeta(atWrapped.token);
      if (docText) {
        return new vscode.Hover(md(docText), new vscode.Range(pos.line, atWrapped.start, pos.line, atWrapped.end));
      }
    }

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

    {
      const reAt = /@([A-Za-z_][A-Za-z0-9_]*)@?/g;
      const m = findMatchAt(lineText, ch, reAt);
      if (m) {
        const name = m[1];
        if (name === 'Map') return undefined; 
        if (AT_CONTROL_WORDS.has(name)) return undefined;

        if (WRITER_KEYWORDS.has(name)) {
          const reused = COMPLETION_DOC_BY_FUNC.get(name);
          if (reused) return new vscode.Hover(reused);
          return new vscode.Hover(md(`**Writer 함수**\n\n\`\`\`abl\n@${name}(...)\n\`\`\`\n\n> Writer 류는 tmLanguage 색을 유지하도록 Semantic에서 제외되어 있습니다.`));
        }

        if (GET_SET_KEYWORDS.has(name)) {
          const reused = COMPLETION_DOC_BY_FUNC.get(name);
          if (reused) return new vscode.Hover(reused);
          return new vscode.Hover(md(`**변수 제어 함수**\n\n\`\`\`abl\n@${name}(...)\n\`\`\``));
        }

        if (BUILTIN_FUNCTIONS.has(name)) {
          const reused = COMPLETION_DOC_BY_FUNC.get(name);
          if (reused) return new vscode.Hover(reused);
          return new vscode.Hover(md(`**내장 함수**\n\n\`\`\`abl\n@${name}(...)\n\`\`\``));
        }

        return new vscode.Hover(md(`**사용자 정의 함수(미등록 호출로 취급)**\n\n\`\`\`abl\n@${name}(...)\n\`\`\``));
      }
    }

    return undefined;
  }
};

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

function getAtIdentAtPosition(doc: vscode.TextDocument, pos: vscode.Position): { name: string; atRange: vscode.Range } | null {
  const lineText = doc.lineAt(pos.line).text;

  const range = doc.getWordRangeAtPosition(pos, /@[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) return null;

  const word = doc.getText(range); 
  if (!word.startsWith('@')) return null;

  const name = word.slice(1);
  if (!name) return null;

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

    const at = getAtIdentAtPosition(doc, pos);
    if (!at) return undefined;

    const name = at.name;

    if (AT_CONTROL_WORDS.has(name)) return undefined;
    if (BUILTIN_FUNCTIONS.has(name)) return undefined;
    if (GET_SET_KEYWORDS.has(name)) return undefined;

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

function findFunctionReferences(doc: vscode.TextDocument, targetName: string): vscode.Location[] {
  const locations: vscode.Location[] = [];
  const re = new RegExp(`@${targetName}(?:@)?\\s*\\(`, 'g');

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    const declRe = new RegExp(`^\\s*@Function\\s+${targetName}\\b`, 'i');
    if (declRe.test(text)) continue;

    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;

      const afterNameIdx = start + 1 + targetName.length;
      const afterNameChar = afterNameIdx < text.length ? text[afterNameIdx] : '';
      if (targetName === 'Map' && afterNameChar === '.') {
        if (m.index === re.lastIndex) re.lastIndex++;
        continue;
      }

      let tokenLen = 1 + targetName.length;
      if (afterNameChar === '@') tokenLen++;

      const range = new vscode.Range(line, start, line, start + tokenLen);
      locations.push(new vscode.Location(doc.uri, range));

      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return locations;
}

const referencesProvider: vscode.ReferenceProvider = {
  provideReferences(doc, pos) {
    if (doc.languageId !== 'abl') return undefined;

    const lineText = doc.lineAt(pos.line).text;

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
            if (AT_CONTROL_WORDS.has(declName)) return undefined;
            if (BUILTIN_FUNCTIONS.has(declName)) return undefined;
            if (WRITER_KEYWORDS.has(declName)) return undefined;
            return findFunctionReferences(doc, declName);
          }
        }
      }
    }

    const at = getAtIdentAtPosition(doc, pos);
    if (!at) return undefined;

    const name = at.name;

    if (AT_CONTROL_WORDS.has(name)) return undefined;
    if (BUILTIN_FUNCTIONS.has(name)) return undefined;
    if (WRITER_KEYWORDS.has(name)) return undefined;

    return findFunctionReferences(doc, name);
  }
};

function collectRenameRanges(
  doc: vscode.TextDocument,
  name: string
): vscode.Range[] {
  const ranges: vscode.Range[] = [];

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

  const callRe = new RegExp(`@${name}(?:@)?\\s*\\(`, 'g');
  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;
    if (!text.trim()) continue;
    if (isCommentLine(text)) continue;

    callRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(text)) !== null) {
      const start = m.index + 1; 
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

type FoldKind = 'function' | 'if' | 'for';

type FoldFrame = {
  kind: FoldKind;
  startLine: number;
};

function provideFoldingRanges(doc: vscode.TextDocument): vscode.FoldingRange[] {
  if (doc.languageId !== 'abl') return [];

  const ranges: vscode.FoldingRange[] = [];
  const stack: FoldFrame[] = [];
  let commentStart: number | null = null;

  const closeCommentBlock = (currentLine: number) => {
    if (commentStart === null) return;
    const end = currentLine - 1;
    if (end > commentStart) {
      ranges.push(new vscode.FoldingRange(commentStart, end, vscode.FoldingRangeKind.Comment));
    }
    commentStart = null;
  };

  for (let line = 0; line < doc.lineCount; line++) {
    const text = doc.lineAt(line).text;

    if (!text.trim()) {
      closeCommentBlock(line);
      continue;
    }

    if (isCommentLine(text)) {
      if (commentStart === null) commentStart = line;
      continue;
    }

    closeCommentBlock(line);

    if (/^\s*@Function\b/i.test(text)) {
      stack.push({ kind: 'function', startLine: line });
      continue;
    }

    if (/^\s*@If\b/i.test(text)) {
      stack.push({ kind: 'if', startLine: line });
      continue;
    }

    if (/^\s*@For\b/i.test(text)) {
      stack.push({ kind: 'for', startLine: line });
      continue;
    }

    if (/^\s*@End\s+Function\b/i.test(text)) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].kind !== 'function') continue;
        const start = stack[i].startLine;
        stack.splice(i, 1);
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

  closeCommentBlock(doc.lineCount);
  ranges.sort((a, b) => (a.start - b.start) || (a.end - b.end));
  return ranges;
}

const foldingProvider: vscode.FoldingRangeProvider = {
  provideFoldingRanges(doc) {
    return provideFoldingRanges(doc);
  }
};

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

function getCallParenIndex(lineText: string, startAt: number, nameLen: number): number | null {
  let j = startAt + 1 + nameLen;
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

  // ⭐ 성능 최적화: 루프 밖으로 정규식 빼기
  const localSetRe = /@Set\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
  const localGetRe = /@Get\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/g;
  const mapName = /@Map\.(Get|Set|Clear)@?/y;

  for (let line = 0; line < doc.lineCount; line++) {
    const lineText = doc.lineAt(line).text;
    if (/^\s*#/.test(lineText)) continue;

    const baseOffset = doc.offsetAt(new vscode.Position(line, 0));
    const funcId = lineToFunc[line];
    const currentFuncName = funcId >= 0 ? funcNameById.get(funcId) : undefined;
    const scanText = maskStringLiterals(lineText);

    if (currentFuncName) {
      localSetRe.lastIndex = 0;
      for (let m; (m = localSetRe.exec(scanText)); ) {
        const name = m[1];
        if (name === currentFuncName) {
          const start = m.index + m[0].lastIndexOf(name);
          pushToken(builder, doc, baseOffset + start, name.length, 'ablReturn');
        }
      }

      localGetRe.lastIndex = 0;
      for (let m; (m = localGetRe.exec(scanText)); ) {
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
    const top = () => (stack.length ? stack[stack.length - 1] : undefined);

    for (let i = 0; i < lineText.length; i++) {
      const ch = lineText[i];

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

      if (ch === '+' || ch === '=') {
        if (ch === '+') {
          const isFirstPlus = i >= 1 && lineText.substring(i - 1, i + 4) === '>+|+<';
          const isSecondPlus = i >= 3 && lineText.substring(i - 3, i + 2) === '>+|+<';
          if (isFirstPlus || isSecondPlus) continue; 
        }
        const prev = i > 0 ? lineText[i - 1] : '';
        const next = i + 1 < lineText.length ? lineText[i + 1] : '';

        if ((ch === '=' && (prev === '>' || prev === '<' || prev === '!' || prev === '=')) || (ch === '=' && next === '=')) {
          // skip
        } else {
          pushToken(builder, doc, baseOffset + i, 1, 'ablOperator');
        }
      }

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

      const isIf = lineText.startsWith('@If', i) && isWordBoundary(lineText, i, 3);
      const isElseIf = lineText.startsWith('@Else', i) && isWordBoundary(lineText, i, 5) && /\s+If\b/.test(lineText.slice(i + 5, i + 20));

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

      if (ifMode && (lineText.startsWith('@Then', i) || lineText.startsWith('@Else', i)) && isWordBoundary(lineText, i, 5) && !(lineText.startsWith('@Else', i) && /\s+If\b/.test(lineText.slice(i + 5, i + 20)))) {
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
          pushToken(builder, doc, baseOffset + i, 2, 'ablOperator');
          i += 1;
          continue;
        }
        if (ch === '=' || ch === '>' || ch === '<') {
          pushToken(builder, doc, baseOffset + i, 1, 'ablOperator');
          continue;
        }
      }

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

      if (ch === '@') {
        const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText.slice(i));
        if (m) {
          const name = m[1];
          const afterName = lineText[i + 1 + name.length] ?? '';
          if (name === 'Map' && afterName === '.') {
            // skip
          } else if (AT_CONTROL_WORDS.has(name)) {
            // skip
          } else if (WRITER_KEYWORDS.has(name)) {
            // skip
          } else if (GET_SET_KEYWORDS.has(name)) {
            // skip
          } else {
            const parenIdx = getCallParenIndex(lineText, i, name.length);
            if (parenIdx !== null) {
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

const diag = vscode.languages.createDiagnosticCollection('abl');
const varDiag = vscode.languages.createDiagnosticCollection('abl-vars');

const declRe = /^\s*@(String|Int)\s+([A-Za-z_][A-Za-z0-9_]*)\b/i;
const setUseRe = /@Set\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
const getUseRe = /@Get\s*\(([^)]*)\)/gi;

const fnStartRe = /^\s*@Function\b/i;
const fnEndRe = /^\s*@End\s+Function\b/i;
const fnNameRe = /^\s*@Function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|$)/i;
const fnParamsRe = /^\s*@Function\b.*?\(([^)]*)\)/i;

function maskStringLiterals(line: string): string {
  let out = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") {
      const next = line[i + 1];
      if (inQ) {
        if (next === "'") {
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
    if (isCommentLine(raw)) continue;

    const funcId = lineToFunc[line]; 
    const text = maskStringLiterals(raw);

    fnNameRe.lastIndex = 0;
    const fm = fnNameRe.exec(text);
    if (fm) {
      const funcName = fm[1];
      if (funcId !== -1) {
        const local = getLocalSet(funcId);
        local.add(funcName);
        fnParamsRe.lastIndex = 0;
        const pm = fnParamsRe.exec(text);
        if (pm) {
          const rawParams = pm[1].trim(); 
          if (rawParams.length > 0) {
            for (const token of rawParams.split(',')) {
              const name = token.trim();
              if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                local.add(name);
              }
            }
          }
        }
      }
      continue;
    }

    declRe.lastIndex = 0;
    const dm = declRe.exec(text);
    if (dm) {
      const varName = dm[2];
      const atIdx = raw.indexOf('@');
      const start = raw.indexOf(varName, atIdx >= 0 ? atIdx : 0);
      const end = start >= 0 ? start + varName.length : raw.length;

      if (funcId === -1) {
        if (globalDeclared.has(varName)) {
          diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, start, line, end), `이미 전역에서 선언된 변수입니다: ${varName}`, vscode.DiagnosticSeverity.Error));
        } else {
          globalDeclared.add(varName);
        }
      } else {
        const local = getLocalSet(funcId);
        if (local.has(varName)) {
          diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, start, line, end), `이미 Function 내에서 선언된 변수입니다: ${varName}`, vscode.DiagnosticSeverity.Error));
        } else {
          local.add(varName);
        }
      }
      continue; 
    }

    const allowedInThisLine = (name: string) => {
      if (funcId === -1) {
        return globalDeclared.has(name);
      } else {
        const local = getLocalSet(funcId);
        return local.has(name) || globalDeclared.has(name);
      }
    };

    setUseRe.lastIndex = 0;
    for (let m; (m = setUseRe.exec(text)); ) {
      const name = m[1];
      if (!allowedInThisLine(name)) {
        const start = m.index + m[0].lastIndexOf(name);
        const end = start + name.length;
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, start, line, end), funcId === -1 ? `전역 영역에서 선언되지 않은 변수입니다: ${name}` : `Function/전역 어디에도 선언되지 않은 변수입니다: ${name}`, vscode.DiagnosticSeverity.Error));
      }
    }

    getUseRe.lastIndex = 0;
    for (let m; (m = getUseRe.exec(raw)); ) {
      const argRaw = m[1];       
      const arg = argRaw.trim(); 
      const openParenCol = m.index + m[0].indexOf('(') + 1;
      const closeParenCol = openParenCol + argRaw.length;
      const argRange = new vscode.Range(line, openParenCol, line, closeParenCol);

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) {
        diagnostics.push(new vscode.Diagnostic(argRange, `@Get()에는 변수명 1개만 올 수 있습니다. (예: @Get(myVar))`, vscode.DiagnosticSeverity.Error));
        continue;
      }

      if (!allowedInThisLine(arg)) {
        diagnostics.push(new vscode.Diagnostic(argRange, funcId === -1 ? `전역 영역에서 선언되지 않은 변수입니다: ${arg}` : `Function/전역 어디에도 선언되지 않은 변수입니다: ${arg}`, vscode.DiagnosticSeverity.Error));
      }
    }

    const decoratedCallRe = /@([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)@\s*\(/g;
    function findMatchingParen(s: string, openIndex: number) {
      let depth = 0;
      for (let i = openIndex; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    function splitTopLevelArgs(argText: string): { text: string; start: number; end: number }[] {
      const out: { text: string; start: number; end: number }[] = [];
      let start = 0;
      let p = 0, b = 0; 
      let inSQ = false, inDQ = false;

      for (let i = 0; i < argText.length; i++) {
        const ch = argText[i];
        if (!inDQ && ch === "'" ) inSQ = !inSQ;
        else if (!inSQ && ch === '"') inDQ = !inDQ;
        if (inSQ || inDQ) continue;
        if (ch === '(') p++;
        else if (ch === ')') p = Math.max(0, p - 1);
        else if (ch === '[') b++;
        else if (ch === ']') b = Math.max(0, b - 1);
        if (ch === ',' && p === 0 && b === 0) {
          out.push({ text: argText.slice(start, i), start, end: i });
          start = i + 1;
        }
      }
      out.push({ text: argText.slice(start), start, end: argText.length });
      return out;
    }

    decoratedCallRe.lastIndex = 0;
    for (let m; (m = decoratedCallRe.exec(raw)); ) {
      const openParenIndex = m.index + m[0].lastIndexOf('('); 
      const closeParenIndex = findMatchingParen(raw, openParenIndex);
      if (closeParenIndex === -1) continue; 

      const argsText = raw.slice(openParenIndex + 1, closeParenIndex);
      const parts = splitTopLevelArgs(argsText);
      if (parts.length === 1 && parts[0].text.trim() === '') continue;

      for (const part of parts) {
        const trimmed = part.text.trim();
        if (!trimmed) continue;
        if (!trimmed.endsWith('@')) {
          const startCol = openParenIndex + 1 + part.start;
          const endCol = openParenIndex + 1 + part.end;
          diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, startCol, line, endCol), `@Func@( ... ) 형태에서는 각 인자가 반드시 '@'로 끝나야 합니다. 예: @Func@(a@,b@)`, vscode.DiagnosticSeverity.Error));
        }
      }
    }

    const caretPathRe = /\^(?:Data|Class)(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\]|\[\])?)*/g;
    caretPathRe.lastIndex = 0;
    for (let m; (m = caretPathRe.exec(raw)); ) {
      const fullPath = m[0];                 
      const endPos = m.index + fullPath.length;
      if (raw[endPos] === '!') continue;
      diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, m.index, line, endPos), `'^' 경로 '${fullPath}' 는 반드시 '!' 로 종료되어야 합니다.`, vscode.DiagnosticSeverity.Error));
    }
  }

  varDiag.set(doc.uri, diagnostics);
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
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, text.length), '@If / @Else If 문에 @Then 이 없습니다.', vscode.DiagnosticSeverity.Error));
      }

      const thenIdx = text.toLowerCase().indexOf('@then');
      let condAll = thenIdx >= 0 ? text.slice(0, thenIdx) : text;
      condAll = condAll.replace(/^\s*@If\b/i, '');
      condAll = condAll.replace(/^\s*@Else\s+If\b/i, '');

      if (hasUnclosedSingleQuoteABL(condAll)) {
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, text.length), "비교식 내 문자열(')이 닫히지 않았습니다.", vscode.DiagnosticSeverity.Error));
        if (isIf) ifStack.push(line);
        continue;
      }
      if (isIf) ifStack.push(line);
      continue;
    }

    if (/^\s*@End\s+If\b/i.test(text)) {
      if (ifStack.length === 0) {
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, text.length), '@End If 에 대응되는 @If 가 없습니다.', vscode.DiagnosticSeverity.Error));
      } else {
        ifStack.pop();
      }
    }

    if (/^\s*@Function\b/i.test(text)) {
      funcStack.push(line);
      continue;
    }

    if (/^\s*@End\s+Function\b/i.test(text)) {
      if (funcStack.length === 0) {
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, text.length), '@End Function 에 대응되는 @Function 이 없습니다.', vscode.DiagnosticSeverity.Error));
      } else {
        funcStack.pop();
      }
      continue;
    }
  }

  for (const line of ifStack) {
    diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, doc.lineAt(line).text.length), '@If 에 대응되는 @End If 가 없습니다.', vscode.DiagnosticSeverity.Error));
  }

  for (const line of funcStack) {
    diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, doc.lineAt(line).text.length), '@Function 에 대응되는 @End Function 이 없습니다.', vscode.DiagnosticSeverity.Error));
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
        diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, text.length), '@End For 에 대응되는 @For 가 없습니다.', vscode.DiagnosticSeverity.Error));
      } else {
        forStack.pop();
      }
    }
  }

  for (const line of forStack) {
    diagnostics.push(new vscode.Diagnostic(new vscode.Range(line, 0, line, doc.lineAt(line).text.length), '@For 에 대응되는 @End For 가 없습니다.', vscode.DiagnosticSeverity.Error));
  }
}

function normalizeThenSpacing(content: string): string {
  if (!/@Then\b/i.test(content)) return content;

  let inQ = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (ch === "'") {
      const next = content[i + 1];
      if (inQ) {
        if (next === "'") { i++; continue; }
        inQ = false; continue;
      } else {
        if (next === "'") { i++; continue; }
        inQ = true; continue;
      }
    }
    if (inQ) continue;

    if ((content[i] === '@' || content[i] === '＠') && content.slice(i).match(/^@Then\b/i)) {
      let j = i - 1;
      while (j >= 0 && (content[j] === ' ' || content[j] === '\t')) j--;
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

      if (/^@(End\s+(If|For|Function)|Else(\s+If)?\b)/i.test(trimmed)) {
        indentLevel = Math.max(0, indentLevel - 1);
      }

      const expectedIndent = '\t'.repeat(indentLevel);
      const currentIndentMatch = raw.match(/^[\t ]*/)?.[0] ?? '';
      const content = raw.slice(currentIndentMatch.length);

      let normalizedContent = content;
      if (/^@If\b/i.test(trimmed) || /^@Else\s+If\b/i.test(trimmed)) {
        normalizedContent = normalizeThenSpacing(content);
      }

      const desiredLine = expectedIndent + normalizedContent;

      if (desiredLine !== raw) {
        edits.push(vscode.TextEdit.replace(new vscode.Range(line, 0, line, raw.length), desiredLine));
      }

      if (/^@(If\b.*@Then\b|Else\s+If\b.*@Then\b|Else\b|For\b|Function\b)/i.test(trimmed)) {
        indentLevel++;
      }
    }

    return edits;
  }
};

function getNextRuleId(doc: vscode.TextDocument): number {
  const text = doc.getText();
  const regex = />\+\|\+<\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?>\+\|\+<(\d+)>\+\|\+</g;
  let maxId = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const id = parseInt(match[1], 10);
    if (id > maxId) {
      maxId = id;
    }
  }
  return maxId + 1; 
}

function getFormattedDate(includeTime: boolean): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  if (!includeTime) return `${yyyy}-${mm}-${dd}`;

  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function insertRuleSnippet(editor: vscode.TextEditor, type: 'General' | 'Pre' | 'Post' | 'Stored') {
  const doc = editor.document;
  const text = doc.getText();

  if (type !== 'General') {
    const marker = `[System]>+|+<${type}>`;
    if (text.includes(marker)) {
      const typeName = type === 'Stored' ? 'User Function' : type === 'Pre' ? 'Preprocessing' : 'Postprocessing';
      vscode.window.showErrorMessage(`[ABL Extension] 이미 ${typeName} 룰이 존재합니다. 해당 룰은 파일당 1개만 생성할 수 있습니다.`);
      return; 
    }
  }

  const nextId = getNextRuleId(doc);
  let snippetStr = '';

  if (type === 'General') {
    const dateStr = getFormattedDate(true); 
    snippetStr = `AnyFile>+|+<\${1:rule_name}>+|+<MMC_MetaSolution          >+|+<YNYYNN>+|+<@ABL('\${2:find_rule}')
>+|+<7>+|+<Y>+|+<@Data()
\${3:rule}
>+|+<Partial Support>+|+<Partial Support>+|+<\${4:rule_description}>+|+<${dateStr}>+|+<${nextId}>+|+<>+|+<${nextId}
MMC1 End Rule Data MMC1\n`;
  } else {
    const dateStr = getFormattedDate(false); 
    snippetStr = `[System]>+|+<${type}>+|+<MMC_MetaSolution          >+|+<>+|+<${type}>+|+<0>+|+<>+|+<\${1:rule}
>+|+<>+|+<>+|+<>+|+<${dateStr}>+|+<${nextId}>+|+<>+|+<${nextId}
MMC1 End Rule Data MMC1\n`;
  }

  editor.insertSnippet(new vscode.SnippetString(snippetStr));
}

// ============================================================
// CodeLens: DB 룰 삭제 버튼 제공
// ============================================================
class RuleCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = doc.getText();
    // 룰 블록 전체를 잡는 정규식 (AnyFile 또는 [System] 으로 시작해서 MMC1 End 로 끝나는 구간)
    const ruleRegex = /^(?:AnyFile|\[System\])>\+\|\+<(.*?)>\+\|\+[\s\S]*?^MMC1 End (?:Rule|Site) Data MMC1/gm;

    let match;
    while ((match = ruleRegex.exec(text)) !== null) {
      const ruleName = match[1];
      const startPos = doc.positionAt(match.index);
      const endPos = doc.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      const lens = new vscode.CodeLens(range, {
        title: `🗑️ Delete from DB (${ruleName})`,
        command: 'abl.deleteRule',
        arguments: [doc.uri, ruleName, range] // 명령어로 uri, 룰이름, 텍스트범위를 넘김
      });
      lenses.push(lens);
    }
    return lenses;
  }
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(diag);
  context.subscriptions.push(varDiag);

// CodeLens 제공자 등록 (에디터에 버튼 띄우기)
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ language: 'abl' }, new RuleCodeLensProvider())
  );

  // DB 삭제 명령어 실제 동작 등록
  context.subscriptions.push(
    vscode.commands.registerCommand('abl.deleteRule', async (uri: vscode.Uri, ruleName: string, range: vscode.Range) => {
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());
      if (!editor) return;

      const doc = editor.document;

      // 1. 실수 방지용 모달 경고창 띄우기
      const answer = await vscode.window.showWarningMessage(
        `정말로 DB에서 '${ruleName}' 룰을 삭제하시겠습니까?\n(삭제 후 에디터에서도 해당 내용이 영구적으로 지워집니다.)`,
        { modal: true },
        'Yes', 'No'
      );

      if (answer !== 'Yes') return;

      // 2. 경로 가져오기
      const config = vscode.workspace.getConfiguration('abl.smartBridge');
      const scriptPath = config.get<string>('deleteScriptPath', 'C:\\VAF\\SmartBridge_JPN\\Delete_Test.ps1');
      const filePath = doc.fileName;

      vscode.window.setStatusBarMessage(`$(sync~spin) SmartBridge: '${ruleName}' 삭제 중...`, 3000);

      // 3. PowerShell 스크립트 실행 (파일경로와 룰이름 2개를 파라미터로 넘김)
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}" "${filePath}" "${ruleName}"`, (error, stdout, stderr) => {
        if (error) {
          vscode.window.showErrorMessage(`[SmartBridge 삭제 실패] ${error.message}`);
          return;
        }

        // 4. 성공하면 에디터에서 해당 룰 텍스트 블록을 스르륵 지워버림
        editor.edit(editBuilder => {
          let endLine = range.end.line;
          if (endLine + 1 < doc.lineCount) endLine++; // 밑에 빈 줄까지 깔끔하게 제거
          const deleteRange = new vscode.Range(range.start.line, 0, endLine, 0);
          editBuilder.delete(deleteRange);
        }).then(success => {
          if (success) {
            vscode.window.showInformationMessage(`[SmartBridge] DB에서 '${ruleName}' 삭제 완료!`);
          }
        });
      });
    })
  );

  context.subscriptions.push(
    vscode.languages.setLanguageConfiguration('abl', {
      indentationRules: {
        increaseIndentPattern: /^\t|^\s*@(?:(?:If\b.*@Then\b)|(?:Else\s+If\b.*@Then\b)|(?:Else\b)|(?:For\b)|(?:Function\b))/i,
        decreaseIndentPattern: /^\s*@(?:(?:End\s+(?:If|For|Function)\b)|(?:Else\b)|(?:Else\s+If\b))/i
      },
      onEnterRules: [
        { beforeText: /^\s*@If\b.*@Then\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Else\s+If\b.*@Then\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Else\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@For\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } },
        { beforeText: /^\s*@Function\b.*$/i, action: { indentAction: vscode.IndentAction.Indent } }
      ]
    })
  );

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

  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'abl' },
      { provideDocumentSemanticTokens: provideTokens },
      legend
    )
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      indexUserFunctions(doc);                 
      provideIfDiagnostics(doc);
      provideUndeclaredVarDiagnostics(doc);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      indexUserFunctions(e.document);          
      provideIfDiagnostics(e.document);
      provideUndeclaredVarDiagnostics(e.document);
    })
  );

  if (vscode.window.activeTextEditor) {
    indexUserFunctions(vscode.window.activeTextEditor.document); 
    provideIfDiagnostics(vscode.window.activeTextEditor.document);
    provideUndeclaredVarDiagnostics(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(vscode.languages.registerHoverProvider({ language: 'abl' }, hoverProvider));
  context.subscriptions.push(vscode.languages.registerDefinitionProvider({ language: 'abl' }, definitionProvider));
  context.subscriptions.push(vscode.languages.registerReferenceProvider({ language: 'abl' }, referencesProvider));
  context.subscriptions.push(vscode.languages.registerRenameProvider({ language: 'abl' }, renameProvider));
  context.subscriptions.push(vscode.languages.registerFoldingRangeProvider({ language: 'abl' }, foldingProvider));
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider({ language: 'abl' }, documentSymbolProvider));

  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'abl' }, formatterProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'abl' }, completionProvider, '@', '^', '.')
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand('abl.addRuleGeneral', (editor) => insertRuleSnippet(editor, 'General')),
    vscode.commands.registerTextEditorCommand('abl.addRulePre', (editor) => insertRuleSnippet(editor, 'Pre')),
    vscode.commands.registerTextEditorCommand('abl.addRulePost', (editor) => insertRuleSnippet(editor, 'Post')),
    vscode.commands.registerTextEditorCommand('abl.addRuleStored', (editor) => insertRuleSnippet(editor, 'Stored'))
  );

  // ============================================================
  // Run On Save (SmartBridge DB 연동)
  // ============================================================
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      // 1. ABL(.rule) 파일이 아니면 무시
      if (doc.languageId !== 'abl') return;

      // 2. 설정창에서 사용자가 입력한 값 가져오기 (기본값은 우리가 세팅한 값)
      const config = vscode.workspace.getConfiguration('abl.smartBridge');
      const isEnabled = config.get<boolean>('enableRunOnSave', true);
      const scriptPath = config.get<string>('scriptPath', 'C:\\VAF\\SmartBridge_JPN\\Connect_Test2.ps1');

      // 기능이 꺼져있으면 무시
      if (!isEnabled) return;

      const filePath = doc.fileName;
      // 3. PowerShell 실행 명령어 조립
      const cmd = `powershell -ExecutionPolicy Bypass -File "${scriptPath}" "${filePath}"`;

      // 4. 실행 및 알림 띄우기
      vscode.window.setStatusBarMessage(`$(sync~spin) Sending rule to SmartBridge...`, 3000);

      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          vscode.window.showErrorMessage(`[Failed to save rule to SmartBridge] ${error.message}`);
          return;
        }
        if (stderr && stderr.trim().length > 0) {
          vscode.window.showWarningMessage(`[SmartBridge Error!] ${stderr}`);
        }
        
        // 성공 시 화면 우측 하단에 알림
        vscode.window.showInformationMessage(`[SmartBridge] Successfully saved rule to SmartBridge! (${stdout.trim() || 'Completed'})`);
      });
    })
  );
}

export function deactivate() {}