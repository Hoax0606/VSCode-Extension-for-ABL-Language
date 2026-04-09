import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Sample test', () => {
    assert.strictEqual(-1, [1, 2, 3].indexOf(5));
    assert.strictEqual(-1, [1, 2, 3].indexOf(0));
  });

  test('ABL language is registered', async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes('abl'), 'abl language should be registered');
  });

  test('ABL file opens with correct language', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'abl',
      content: '@If @Get(nIdx) > 0 @Then\n@End If'
    });
    assert.strictEqual(doc.languageId, 'abl');
  });
});