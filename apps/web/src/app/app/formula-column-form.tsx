'use client';

import type { GridSnapshot } from '@byok-grid/db';
import {
  collectFormulaColumnIds,
  formulaColumnReference,
  parseFormulaSource,
  validateFormulaDefinition,
  MAXIMUM_FORMULA_SOURCE_CHARACTERS,
  type CellValueType,
  type FormulaExpression,
  type FormulaSourceColumn,
} from '@byok-grid/domain';
import { type FormEvent, useMemo, useRef, useState } from 'react';

type FormulaOperation = 'coalesce' | 'combine' | 'lower' | 'trim' | 'upper';
type AuthoringMode = 'formula' | 'guided';

const functionTemplates = [
  'CONCAT',
  'COALESCE',
  'IF',
  'EQUALS',
  'ADD',
  'SUBTRACT',
  'MULTIPLY',
  'DIVIDE',
  'LOWER',
  'UPPER',
  'TRIM',
] as const;

export function FormulaColumnForm({
  columns,
  tableId,
  workspaceId,
}: {
  columns: GridSnapshot['columns'];
  tableId: string;
  workspaceId: string;
}) {
  const [authoringMode, setAuthoringMode] = useState<AuthoringMode>('guided');
  const [operation, setOperation] = useState<FormulaOperation>('combine');
  const [formulaSource, setFormulaSource] = useState(() =>
    defaultFormulaSource(columns)
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const formulaInput = useRef<HTMLTextAreaElement>(null);

  const sourceColumns = useMemo(
    () =>
      operation === 'lower' || operation === 'trim' || operation === 'upper'
        ? columns.filter((column) => column.valueType === 'text')
        : columns,
    [columns, operation]
  );
  const formulaColumns = useMemo<FormulaSourceColumn[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        name: column.name,
        valueType: column.valueType,
      })),
    [columns]
  );
  const formulaValidation = useMemo(
    () => validateFormulaSource(formulaSource, formulaColumns),
    [formulaColumns, formulaSource]
  );

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    let definition: { expression: FormulaExpression } | { source: string };
    if (authoringMode === 'formula') {
      if (!formulaValidation.valid) {
        setError(formulaValidation.error);
        return;
      }
      definition = { source: formulaSource };
    } else {
      definition = {
        expression: buildExpression(
          operation,
          String(data.get('sourceA') ?? ''),
          String(data.get('sourceB') ?? ''),
          String(data.get('separator') ?? '')
        ),
      };
    }

    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/tables/${tableId}/columns/formula`,
        {
          body: JSON.stringify({
            ...definition,
            name: String(data.get('name') ?? ''),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(
          body.error ?? 'The formula column could not be created.'
        );
      }
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request failed.');
      setPending(false);
    }
  }

  function insertFormulaText(text: string, cursorOffset = text.length) {
    const input = formulaInput.current;
    const start = input?.selectionStart ?? formulaSource.length;
    const end = input?.selectionEnd ?? formulaSource.length;
    setFormulaSource(
      (current) => `${current.slice(0, start)}${text}${current.slice(end)}`
    );
    requestAnimationFrame(() => {
      formulaInput.current?.focus();
      formulaInput.current?.setSelectionRange(
        start + cursorOffset,
        start + cursorOffset
      );
    });
  }

  const requiresSecondSource =
    operation === 'coalesce' || operation === 'combine';

  return (
    <section className="formula-config">
      <div className="credential-heading">
        <div>
          <p className="eyebrow">COMPUTED COLUMN</p>
          <h2>Build a deterministic formula</h2>
        </div>
        <p>
          Formula dependencies recalculate atomically whenever an input changes.
        </p>
      </div>

      <div
        className="formula-mode-switcher"
        role="group"
        aria-label="Formula authoring mode"
      >
        <button
          aria-pressed={authoringMode === 'guided'}
          className={authoringMode === 'guided' ? 'active' : undefined}
          onClick={() => setAuthoringMode('guided')}
          type="button"
        >
          Guided
        </button>
        <button
          aria-pressed={authoringMode === 'formula'}
          className={authoringMode === 'formula' ? 'active' : undefined}
          onClick={() => setAuthoringMode('formula')}
          type="button"
        >
          Formula language
        </button>
      </div>

      {authoringMode === 'guided' ? (
        <form className="formula-form" method="post" onSubmit={create}>
          <label>
            Column name
            <input name="name" placeholder="Company label" required />
          </label>
          <label>
            Operation
            <select
              name="operation"
              onChange={(event) =>
                setOperation(event.currentTarget.value as FormulaOperation)
              }
              value={operation}
            >
              <option value="combine">Combine text</option>
              <option value="coalesce">First non-empty</option>
              <option value="lower">Lowercase</option>
              <option value="upper">Uppercase</option>
              <option value="trim">Trim whitespace</option>
            </select>
          </label>
          <label>
            First source
            <select key={`${operation}:a`} name="sourceA" required>
              {sourceColumns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          {requiresSecondSource ? (
            <label>
              Second source
              <select name="sourceB" required>
                {sourceColumns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {operation === 'combine' ? (
            <label>
              Separator
              <input defaultValue=" · " name="separator" />
            </label>
          ) : null}
          <FormulaSubmit
            disabled={pending || sourceColumns.length === 0}
            error={error}
            pending={pending}
          />
        </form>
      ) : (
        <form className="formula-language-form" method="post" onSubmit={create}>
          <label className="formula-name-field">
            Column name
            <input name="name" placeholder="Qualified score" required />
          </label>
          <div className="formula-insert-tools">
            <label>
              Insert column
              <select
                aria-label="Insert column reference"
                onChange={(event) => {
                  const column = columns.find(
                    (candidate) => candidate.id === event.currentTarget.value
                  );
                  if (column)
                    insertFormulaText(formulaColumnReference(column.name));
                  event.currentTarget.value = '';
                }}
                value=""
              >
                <option value="">Choose a column…</option>
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.name} · {formatValueType(column.valueType)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Insert function
              <select
                aria-label="Insert formula function"
                onChange={(event) => {
                  const fn = event.currentTarget.value;
                  if (fn) insertFormulaText(`${fn}()`, fn.length + 1);
                  event.currentTarget.value = '';
                }}
                value=""
              >
                <option value="">Choose a function…</option>
                {functionTemplates.map((fn) => (
                  <option key={fn} value={fn}>
                    {fn}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="formula-source-field">
            Formula
            <textarea
              aria-describedby="formula-language-status formula-language-help"
              maxLength={MAXIMUM_FORMULA_SOURCE_CHARACTERS}
              onChange={(event) => setFormulaSource(event.currentTarget.value)}
              ref={formulaInput}
              rows={5}
              spellCheck={false}
              value={formulaSource}
            />
          </label>
          <div
            className={`formula-language-status ${formulaValidation.valid ? 'valid' : 'invalid'}`}
            id="formula-language-status"
            role="status"
          >
            {formulaValidation.valid
              ? `Returns ${formatValueType(formulaValidation.resultType)} · ${formulaValidation.dependencyCount} source ${formulaValidation.dependencyCount === 1 ? 'column' : 'columns'}`
              : formulaValidation.error}
          </div>
          <details className="formula-language-help" id="formula-language-help">
            <summary>Formula language reference</summary>
            <p>
              Reference columns as <code>[Company]</code>. Use double-quoted
              text, finite numbers, <code>TRUE</code>, <code>FALSE</code>, or{' '}
              <code>EMPTY</code>. Nest functions such as{' '}
              <code>IF(EQUALS([Active], TRUE), ADD([Score], 10), [Score])</code>
              .
            </p>
            <p>
              Available functions: {functionTemplates.join(', ')}. Timestamp and
              JSON literals use <code>TIMESTAMP(&quot;…Z&quot;)</code> and{' '}
              <code>JSON(&quot;…&quot;)</code>.
            </p>
          </details>
          <FormulaSubmit
            disabled={pending || !formulaValidation.valid}
            error={error}
            pending={pending}
          />
        </form>
      )}
    </section>
  );
}

function FormulaSubmit({
  disabled,
  error,
  pending,
}: {
  disabled: boolean;
  error: string | undefined;
  pending: boolean;
}) {
  return (
    <div className="formula-submit">
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="primary-action" disabled={disabled} type="submit">
        {pending ? 'Creating…' : 'Add formula column'}
      </button>
    </div>
  );
}

function validateFormulaSource(
  source: string,
  columns: readonly FormulaSourceColumn[]
):
  | {
      dependencyCount: number;
      expression: FormulaExpression;
      resultType: Exclude<CellValueType, 'empty'>;
      valid: true;
    }
  | { error: string; valid: false } {
  if (!source.trim()) return { error: 'Enter a formula.', valid: false };
  try {
    const expression = parseFormulaSource(source, columns);
    const dependencyCount = collectFormulaColumnIds(expression).length;
    if (dependencyCount === 0) {
      return {
        error: 'Reference at least one source column.',
        valid: false,
      };
    }
    return {
      dependencyCount,
      expression,
      resultType: validateFormulaDefinition(
        expression,
        new Map(columns.map((column) => [column.id, column.valueType]))
      ),
      valid: true,
    };
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause.message : 'The formula is invalid.',
      valid: false,
    };
  }
}

function defaultFormulaSource(columns: GridSnapshot['columns']): string {
  const textColumns = columns.filter((column) => column.valueType === 'text');
  if (textColumns.length >= 2) {
    return `=CONCAT(${formulaColumnReference(textColumns[0]!.name)}, " · ", ${formulaColumnReference(textColumns[1]!.name)})`;
  }
  const first = columns[0];
  return first ? `=COALESCE(${formulaColumnReference(first.name)}, EMPTY)` : '';
}

function formatValueType(valueType: CellValueType): string {
  switch (valueType) {
    case 'empty':
      return 'Empty';
    case 'text':
      return 'Text';
    case 'number':
      return 'Number';
    case 'boolean':
      return 'True / false';
    case 'timestamp':
      return 'Date & time';
    case 'json':
      return 'JSON';
  }
}

function buildExpression(
  operation: FormulaOperation,
  sourceA: string,
  sourceB: string,
  separator: string
): FormulaExpression {
  const first: FormulaExpression = { type: 'column', columnId: sourceA };
  if (operation === 'combine') {
    return {
      type: 'call',
      function: 'concat',
      args: [
        first,
        { type: 'literal', value: { type: 'text', value: separator } },
        { type: 'column', columnId: sourceB },
      ],
    };
  }
  if (operation === 'coalesce') {
    return {
      type: 'call',
      function: 'coalesce',
      args: [first, { type: 'column', columnId: sourceB }],
    };
  }
  return { type: 'call', function: operation, args: [first] };
}
