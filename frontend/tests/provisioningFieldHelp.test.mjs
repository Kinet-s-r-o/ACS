import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { parse } from '@babel/parser';

const source = readFileSync(new URL('../src/lib/provisioningFieldHelp.ts', import.meta.url), 'utf8');
const help = {};
const helpScript = stripTypeScriptTypes(source.replace(/^import .*$/gm, '').replace(/export const /g, 'const '))
  + '\nObject.assign(exports, { ruleFieldHelp, metricFieldHelp, interfaceFieldHelp, pollingFieldHelp });';
vm.runInNewContext(helpScript, {
  exports: help,
  ConditionHelpContent: () => null,
});

const attribute = (node, name) => node.attributes.find(prop => prop.type === 'JSXAttribute' && prop.name.name === name)?.value;
const textAttribute = (node, name) => {
  const value = attribute(node, name);
  return value?.type === 'StringLiteral' ? value.value : undefined;
};
const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(item => item?.type) : value?.type ? [value] : []);

for (const file of ['components/MetricModal.tsx', 'pages/Provisioning.tsx', 'pages/MetricsSettings.tsx', 'pages/Settings.tsx']) {
  test(`${file}: every editable field in help dialogs has a help topic`, () => {
    const fileSource = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const sourceFile = parse(fileSource, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
    let dialogs = 0;
    function visit(node) {
      if (node.type === 'JSXElement' && node.openingElement.name.name === 'FieldHelpDialog') {
        dialogs++;
        const topics = help[attribute(node.openingElement, 'topics').expression.name];
        assert.ok(topics, 'dialog must use a known topic collection');
        const labels = new Map();
        const fields = [];
        function collect(child, helped = false) {
          if (child.type === 'JSXElement') {
            const opening = child.openingElement;
            const name = opening.name.name;
            if (name === 'HelpLabel') {
              const key = textAttribute(opening, 'help') ?? textAttribute(opening, 'for');
              assert.ok(topics[key], `missing help topic ${key}`);
              const target = textAttribute(opening, 'for');
              if (target) labels.set(target, key);
              helped = true;
            }
            if (['input', 'select', 'textarea'].includes(name)) fields.push({ opening, helped });
          }
          for (const next of children(child)) collect(next, helped);
        }
        collect(node);
        for (const { opening, helped } of fields) {
          assert.ok(helped || labels.has(textAttribute(opening, 'id')), `field has no help: ${fileSource.slice(opening.start, opening.end).slice(0, 100)}`);
        }
        assert.ok(fields.length > 0);
        return;
      }
      for (const next of children(node)) visit(next);
    }
    visit(sourceFile);
    assert.equal(dialogs, file.endsWith('Provisioning.tsx') ? 3 : 1);
  });
}

test('all help topics contain operational explanations and conditions retain their full reference', () => {
  for (const topics of Object.values(help)) {
    for (const topic of Object.values(topics)) {
      assert.ok(topic.title);
      assert.ok(topic.paragraphs.length > 0 && topic.paragraphs.every(text => text.length > 20));
    }
  }
  assert.equal(typeof help.ruleFieldHelp['provisioning-condition'].content, 'function');
});
