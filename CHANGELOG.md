# Change Log

All notable changes to the "abl-language" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.


## [1.0.0] - 2026-03-04
### Fixed
- Changed colors for syntax highlighting
- Refactored all codes
### Added
- Added Git for cooperation
- Added DB Connection (saves to DB automatically when saving file)
- Added rule deletion
- Added Run On Save extension integration (runs file when saving)
---

## [0.0.7] - 2026-02-18
### Fixed
- Fixed error where higlighted function name shows in comments
### Added
- Added error diagnostic for duplicated variable declaration
- Added variable recommendation for @Get and @Set
- Added StrToken related grammar rules and auto completion
---

## [0.0.6] - 2026-02-12
### Fixed
- Fixed syntax matching error for %idx_ 
- Fixed @Map.Get(value@) → @Map.Get@(key@)
- Deleted first space for Writer when auto completing
- Fixed LowerCase typo error
### Added
- Added folding for comments
- Added description for @DisplayLog
- Added placeholder for function name in @Function

---

## [0.0.5] - 2026-01-20
### Added
- Added user function name in auto completion suggestions

---

## [0.0.4] - 2026-01-13
### Fixed
- Fixed ^Data.[].Name! and ^Class.Name! to show error when ! is missing
- Fixed functions and maps to show error when @ is missing

---

## [0.0.3] - 2026-01-13
### Added
- Added documentation for @Get, @Set
### Fixed
- Variables used as function parameters to not show error
- Fixed '' in If
- Fixed '@Get()' not showing error for undeclared variable

---

## [0.0.2] - 2026-01-12
### Added
- Function return name highlighting (ablReturn)
### Fixed
- Undeclared variable diagnostics: allow @Set <FunctionName> inside function
- Undeclared variable diagnostics: allow @Set <VarName> outside of function to not display error if it is declared

---

## [0.0.1] - 2026-01-11
- Initial release
