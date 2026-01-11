# ABL Language Support for VS Code

Value & Force SmartBridge에서 사용하는  
**ABL (Analysis & Basis Language)** 를  
Visual Studio Code 환경에서 효율적으로 작성하기 위한 Language Support Extension입니다.

본 Extension은 단순 문법 하이라이팅을 넘어  
**자동 완성, Hover, 정적 분석, 코드 구조화**까지 지원합니다.

---

## 📌 주요 특징

- ABL 전용 문법 하이라이팅 (TextMate + Semantic Tokens)
- 컨텍스트 인식 자동 완성 (IntelliSense)
- Hover 도움말 (Completion 문서 재사용)
- 자동 들여쓰기 / 내어쓰기
- 코드 접기 (Folding)
- Outline (문서 구조 보기)
- 정적 분석 (미선언 변수, 스코프 오류 등)
- 사용자 정의 함수 지원
- Go to Definition / References / Rename 지원

---

## 📂 지원 파일 확장자

- `.abl`
- `.rule`

---

## ✨ Syntax Highlighting

### TextMate Grammar
- 제어문, 키워드, 연산자
- Writer 함수(@AddLine, @InsertLine 등)
- 토큰 접근 문법(^Data, ^Class)

### Semantic Tokens
- 함수 호출 범위 전체 색상 유지
- 사용자 정의 함수 선언 / 호출 색상 분리
- Map 계열 함수(@Map.Get / @Map.Set)
- 논리 연산자(+, =, 비교 연산자) 조건부 강조

---

## ✍️ 자동 들여쓰기 / 내어쓰기

지원 문법:
- `@If / @Else If / @Else / @End If`
- `@For / @End For`
- `@Function / @End Function`

특징:
- Snippet 선택 시에도 Indent / Outdent 정상 동작
- 중첩 구조 안정적 처리
- `@Else`, `@Else If` → Outdent + Indent
- `@End *` → 자동 Outdent

---

## ⚡ Snippet & IntelliSense

### `@` 트리거
- `@Function`, `@End Function`
- 제어문 / 반복문
- 내장 함수
- Writer 함수

### 컨텍스트 기반 자동 완성
- `@Map.` → `Get / Set / Clear`
- `^Data.` → `Count! / Item[].`
- `^Data.Item[].` → `Name! / Type! / Pretab!` 등
- `StringTokenInfo[].` → 속성 자동 완성

---

## 🛈 Hover (도움말)

Completion에서 정의한 설명을 **Hover에서도 재사용**

지원 대상:
- 내장 함수 (`@LowerCase`, `@Replace` 등)
- Writer 함수 (`@AddLine`, `@Data` 등)
- `^Data`, `^Class`
- `^Data.Item[].Name!`, `Pretab!` 등 하위 속성

---

## 🧩 사용자 정의 함수

- `@Function ~ @End Function` 구조 인식
- 선언 / 종료 키워드 색상 분리
- **선언 이전 호출도 정상 인식**
- 사용자 정의 함수 호출 색상 적용

---

## 🧪 정적 분석 (Diagnostics)

### 제어문 오류
- `@If / @Else If` 에서 `@Then` 누락
- `@End If`, `@End For` 미매칭

### 변수 스코프 검사
- 로컬 변수는 `@Function ~ @End Function` 내부에서만 사용 가능
- 함수 외부에서 `@Get / @Set` 사용 시 오류

### 변수 선언 규칙
- 변수 선언은 `@String` 또는 `@Int` 만 허용
- 동일 변수 중복 선언 불가
- 선언과 동시에 초기화 불가
- 미선언 변수 사용 시 오류 표시