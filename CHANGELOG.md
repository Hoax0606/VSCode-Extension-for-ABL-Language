# Change Log

All notable changes to the "abl-language" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release

## [0.0.2] - 2026-01-12
### Added
- Function return name highlighting (ablReturn)
### Fixed
- Undeclared variable diagnostics: allow @Set <FunctionName> inside function
- Undeclared variable diagnostics: allow @Set <VarName> outside of function to not display error if it is declared

## [0.0.3] - 2026-01-12
### Added
- Added documentation for @Get, @Set
### Fixed
- Variables used as function parameters to not show error
- fixed '' in If
- fixed '@Get()' not showing error for undeclared variable