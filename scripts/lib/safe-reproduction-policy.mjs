import { parse } from '@babel/parser';

const EXPECTED_ACTIONS = {
  deploy: ['enableModule'],
  smoke: ['activateMandate'],
  e2e: ['cancelEscalated', 'executeEscalated'],
  evidence: ['activateMandate', 'executeEscalated'],
};

function parseTypeScript(source, fileName) {
  try {
    return parse(source, {
      sourceType: 'module',
      sourceFilename: fileName,
      plugins: ['typescript', 'importAttributes'],
    });
  } catch (error) {
    throw new Error(`cannot parse ${fileName}: ${error.message}`, { cause: error });
  }
}

function walk(node, visitor, parent = undefined) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visitor(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'errors', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === 'string') walk(child, visitor, node);
      }
    } else if (value && typeof value.type === 'string') {
      walk(value, visitor, node);
    }
  }
}

function unwrap(expression) {
  let current = expression;
  while (current && [
    'AwaitExpression',
    'ParenthesizedExpression',
    'TSAsExpression',
    'TSTypeAssertion',
    'TSNonNullExpression',
  ].includes(current.type)) {
    current = current.type === 'AwaitExpression' ? current.argument : current.expression;
  }
  return current;
}

function sourceText(node, source) {
  return typeof node?.start === 'number' && typeof node?.end === 'number'
    ? source.slice(node.start, node.end)
    : '';
}

function keyName(key) {
  if (key?.type === 'Identifier') return key.name;
  if (key?.type === 'StringLiteral') return key.value;
  return undefined;
}

function objectProperty(object, name) {
  return object?.properties?.find(
    (candidate) => candidate.type === 'ObjectProperty' && keyName(candidate.key) === name,
  );
}

function stringValue(expression) {
  const value = unwrap(expression);
  return value?.type === 'StringLiteral' ? value.value : undefined;
}

function callName(callee) {
  const value = unwrap(callee);
  if (value?.type === 'Identifier') return value.name;
  if (
    value?.type === 'MemberExpression'
    && (!value.computed || value.property.type === 'StringLiteral')
  ) {
    return keyName(value.property);
  }
  return undefined;
}

function memberPath(expression, variables, seen = new Set()) {
  const value = unwrap(expression);
  if (!value) return undefined;
  if (value.type === 'Identifier') {
    if (
      ['deployments', 'Safe', 'SAFE', 'safeAddress', 'VeilGuardModule', 'MODULE', 'module_']
        .includes(value.name)
    ) {
      return [value.name];
    }
    if (seen.has(value.name)) return [value.name];
    const initializer = variables?.get(value.name);
    if (!initializer) return [value.name];
    seen.add(value.name);
    return memberPath(initializer, variables, seen);
  }
  if (
    value.type !== 'MemberExpression'
    || (value.computed && value.property.type !== 'StringLiteral')
  ) {
    return undefined;
  }
  const object = memberPath(value.object, variables, seen);
  const property = keyName(value.property);
  return object && property ? [...object, property] : undefined;
}

function isSafeAddressExpression(expression, variables) {
  const path = memberPath(expression, variables);
  if (!path) return false;
  if (path.length === 1 && ['Safe', 'SAFE', 'safeAddress'].includes(path[0])) return true;
  return path.at(-1) === 'Safe'
    && path.some((part) => ['contracts', 'deployments'].includes(part));
}

function isModuleAddressExpression(expression, variables) {
  const path = memberPath(expression, variables);
  return Boolean(
    path
    && (
      (path.length === 1 && ['VeilGuardModule', 'MODULE', 'module_'].includes(path[0]))
      || path.at(-1) === 'VeilGuardModule'
    )
  );
}

function bindingContains(binding, name) {
  if (!binding) return false;
  if (binding.type === 'Identifier') return binding.name === name;
  if (binding.type === 'RestElement') return bindingContains(binding.argument, name);
  if (binding.type === 'AssignmentPattern') return bindingContains(binding.left, name);
  if (binding.type === 'ObjectPattern') {
    return binding.properties.some((property) => (
      property.type === 'RestElement'
        ? bindingContains(property.argument, name)
        : bindingContains(property.value, name)
    ));
  }
  if (binding.type === 'ArrayPattern') {
    return binding.elements.some((element) => bindingContains(element, name));
  }
  return false;
}

function buildParentMap(ast) {
  const parents = new Map();
  walk(ast, (node, parent) => {
    if (parent) parents.set(node, parent);
  });
  return parents;
}

const CONTROL_FLOW_ANCESTORS = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchStatement',
  'SwitchCase',
  'TryStatement',
  'CatchClause',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

function isProgramLevelExecution(node, parents) {
  let current = node;
  while (parents.has(current)) {
    current = parents.get(current);
    if (current.type === 'Program') return true;
    if (
      ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(current.type)
      || CONTROL_FLOW_ANCESTORS.has(current.type)
    ) {
      return false;
    }
  }
  return false;
}

function isDirectProgramExecution(node, parents) {
  const transparent = new Set([
    'AwaitExpression',
    'ParenthesizedExpression',
    'TSAsExpression',
    'TSTypeAssertion',
    'TSNonNullExpression',
    'ExpressionStatement',
    'VariableDeclarator',
    'VariableDeclaration',
  ]);
  let current = node;
  while (parents.has(current)) {
    current = parents.get(current);
    if (current.type === 'Program') return true;
    if (!transparent.has(current.type)) return false;
  }
  return false;
}

function isFailClosedIf(node) {
  return node?.type === 'IfStatement'
    && node.alternate == null
    && node.consequent.type === 'BlockStatement'
    && node.consequent.body.length === 1
    && node.consequent.body[0].type === 'ThrowStatement';
}

function isIdentifier(expression, name) {
  const value = unwrap(expression);
  return value?.type === 'Identifier' && value.name === name;
}

function isMember(expression, objectName, propertyName) {
  const value = unwrap(expression);
  return value?.type === 'MemberExpression'
    && (!value.computed || value.property.type === 'StringLiteral')
    && isIdentifier(value.object, objectName)
    && keyName(value.property) === propertyName;
}

function isBinaryGuard(node, leftMatcher, operator, rightMatcher) {
  const value = unwrap(node);
  return value?.type === 'BinaryExpression'
    && value.operator === operator
    && leftMatcher(value.left)
    && rightMatcher(value.right);
}

function isCall(expression, calleeMatcher) {
  const value = unwrap(expression);
  return value?.type === 'CallExpression' && calleeMatcher(value.callee)
    ? value
    : undefined;
}

function directDeclarator(statement, name) {
  if (statement?.type !== 'VariableDeclaration' || statement.declarations.length !== 1) {
    return undefined;
  }
  const declaration = statement.declarations[0];
  return declaration.id.type === 'Identifier' && declaration.id.name === name
    ? declaration
    : undefined;
}

function objectContainsSafeTarget(expression, variables, propertyName) {
  const object = resolveInitializer(expression, variables);
  if (object?.type !== 'ObjectExpression') return false;
  const target = objectProperty(object, propertyName);
  return Boolean(target && isSafeAddressExpression(target.value, variables));
}

function governanceActionInObject(expression, variables) {
  const object = resolveInitializer(expression, variables);
  if (object?.type !== 'ObjectExpression') return undefined;
  const address = objectProperty(object, 'address');
  const functionName = objectProperty(object, 'functionName');
  if (!address || !functionName || !isModuleAddressExpression(address.value, variables)) {
    return undefined;
  }
  const resolvedName = resolveInitializer(functionName.value, variables);
  const action = stringValue(resolvedName);
  return Object.values(EXPECTED_ACTIONS).flat().includes(action) ? action : undefined;
}

function containsSafeTarget(expression, variables) {
  const value = resolveInitializer(expression, variables);
  if (!value) return false;
  if (value.type === 'ObjectExpression') {
    if (
      objectContainsSafeTarget(value, variables, 'address')
      || objectContainsSafeTarget(value, variables, 'to')
    ) {
      return true;
    }
    return value.properties.some((property) => (
      property.type === 'ObjectProperty' && containsSafeTarget(property.value, variables)
    ));
  }
  if (value.type === 'ArrayExpression') {
    return value.elements.some((element) => containsSafeTarget(element, variables));
  }
  return false;
}

function isDeploymentsMutationTarget(expression, variables) {
  const path = memberPath(expression, variables);
  return Boolean(path && path[0] === 'deployments');
}

function resolveInitializer(expression, variables, seen = new Set()) {
  const value = unwrap(expression);
  if (value?.type !== 'Identifier' || seen.has(value.name)) return value;
  const initializer = variables.get(value.name);
  if (!initializer) return value;
  seen.add(value.name);
  return resolveInitializer(initializer, variables, seen);
}

function encodedFunctionName(expression, variables) {
  const value = resolveInitializer(expression, variables);
  if (value?.type !== 'CallExpression' || callName(value.callee) !== 'encodeFunctionData') return undefined;
  const options = unwrap(value.arguments[0]);
  if (options?.type !== 'ObjectExpression') return undefined;
  const functionName = objectProperty(options, 'functionName');
  if (!functionName) return undefined;
  const literal = stringValue(functionName.value);
  if (literal) return literal;
  const dynamic = unwrap(functionName.value);
  return dynamic?.type === 'Identifier' ? `$${dynamic.name}` : undefined;
}

function comparisonExists(ast, source, left, operator, right) {
  let found = false;
  walk(ast, (node) => {
    if (found || node.type !== 'BinaryExpression' || node.operator !== operator) return;
    const actualLeft = sourceText(unwrap(node.left), source);
    const actualRight = sourceText(unwrap(node.right), source);
    found = (actualLeft === left && actualRight === right)
      || (actualLeft === right && actualRight === left);
  });
  return found;
}

function addViolation(violations, code, message) {
  if (!violations.some((violation) => violation.code === code)) violations.push({ code, message });
}

export function auditSafeScriptSource(source, kind, fileName = `${kind}.ts`) {
  if (!EXPECTED_ACTIONS[kind]) throw new Error(`unknown Safe script kind: ${kind}`);
  const ast = parseTypeScript(source, fileName);
  const parents = buildParentMap(ast);
  const violations = [];
  const variables = new Map();
  const variableCounts = new Map();
  let importsHelper = false;
  let setupSeen = false;
  const setupBindings = [];
  const factorySetupUses = [];
  const helperTargets = [];
  const safeCallTargets = new Set();
  let deploymentManifestSeen = false;
  let deploymentManifestWritten = false;
  let evidenceReuseInput = false;
  const evidenceResultBindings = new Map();
  let evidenceActivationRecorded = false;
  let evidenceApprovalRecorded = false;
  const evidenceResultMutations = new Set();

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      variables.set(node.id.name, node.init);
      variableCounts.set(node.id.name, (variableCounts.get(node.id.name) ?? 0) + 1);
    }
  });

  const inspectSetup = (call) => {
    if (!isProgramLevelExecution(call, parents)) return;
    const options = unwrap(call.arguments[0]);
    if (options?.type !== 'ObjectExpression') return;
    const functionName = objectProperty(options, 'functionName');
    if (!functionName || stringValue(functionName.value) !== 'setup') return;
    setupSeen = true;
    const binding = parents.get(call);
    const declaration = binding?.type === 'VariableDeclarator' ? parents.get(binding) : undefined;
    let scope = declaration;
    while (scope && !['BlockStatement', 'Program'].includes(scope.type)) {
      scope = parents.get(scope);
    }
    setupBindings.push({
      binding,
      declaration,
      scope,
      isCanonical: binding?.type === 'VariableDeclarator'
        && binding.id.type === 'Identifier'
        && binding.id.name === 'initializer'
        && declaration?.type === 'VariableDeclaration'
        && declaration.kind === 'const'
        && declaration.declarations.length === 1,
    });
    const args = unwrap(objectProperty(options, 'args')?.value);
    if (args?.type !== 'ArrayExpression' || args.elements.length < 2) {
      addViolation(violations, 'deploy-setup-shape', 'Safe setup must expose owners and threshold arguments');
      return;
    }
    const owners = unwrap(args.elements[0]);
    if (owners?.type !== 'ArrayExpression' || owners.elements.length !== 2) {
      addViolation(violations, 'deploy-setup-owners', 'Fresh Safe setup must contain exactly two owners');
    } else {
      const distinctOwners = new Set(owners.elements.map((owner) => sourceText(unwrap(owner), source)));
      if (distinctOwners.size !== 2) {
        addViolation(violations, 'deploy-setup-owners', 'Fresh Safe setup owners must be distinct');
      }
    }
    if (sourceText(unwrap(args.elements[1]), source) !== '2n') {
      addViolation(violations, 'deploy-setup-threshold', 'Fresh Safe setup threshold must be the bigint literal 2n');
    }
  };

  const inspectDeploymentManifest = (node) => {
    if (
      kind !== 'deploy'
      || node.type !== 'VariableDeclarator'
      || node.id.type !== 'Identifier'
      || node.id.name !== 'deployments'
      || !isProgramLevelExecution(node, parents)
    ) return;
    const manifest = unwrap(node.init);
    if (manifest?.type !== 'ObjectExpression') return;
    const safeObject = unwrap(objectProperty(manifest, 'safe')?.value);
    if (safeObject?.type !== 'ObjectExpression') return;
    deploymentManifestSeen = true;
    const owners = objectProperty(safeObject, 'owners');
    const threshold = objectProperty(safeObject, 'threshold');
    if (!owners || !threshold) {
      addViolation(violations, 'deploy-manifest-shape', 'Deployment output must record Safe owners and threshold');
      return;
    }

    const thresholdExpression = unwrap(threshold.value);
    const isVerifiedRuntimeThreshold = (
      thresholdExpression?.type === 'CallExpression'
      && callName(thresholdExpression.callee) === 'Number'
      && thresholdExpression.arguments.length === 1
      && sourceText(unwrap(thresholdExpression.arguments[0]), source) === 'safeThreshold'
    );
    if (!isVerifiedRuntimeThreshold && sourceText(thresholdExpression, source) !== '2') {
      addViolation(violations, 'deploy-manifest-threshold', 'Deployment output must record the verified threshold-two value');
    }

    const ownersExpression = unwrap(owners.value);
    const isVerifiedRuntimeOwners = ownersExpression?.type === 'Identifier'
      && ownersExpression.name === 'safeOwners';
    const isTwoLiteralOwners = ownersExpression?.type === 'ArrayExpression'
      && ownersExpression.elements.length === 2
      && new Set(ownersExpression.elements.map((owner) => sourceText(unwrap(owner), source))).size === 2;
    if (!isVerifiedRuntimeOwners && !isTwoLiteralOwners) {
      addViolation(violations, 'deploy-manifest-owners', 'Deployment output must record the verified two-owner set');
    }
  };

  const isE2eWrapperCall = (call) => {
    if (kind !== 'e2e') return false;
    let current = call;
    let parent = parents.get(current);
    while (parent && [
      'AwaitExpression',
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
    ].includes(parent.type)) {
      current = parent;
      parent = parents.get(current);
    }
    if (parent?.type !== 'ArrowFunctionExpression' || unwrap(parent.body) !== call) return false;
    const declaration = parents.get(parent);
    if (
      declaration?.type !== 'VariableDeclarator'
      || declaration.id.type !== 'Identifier'
      || declaration.id.name !== 'safeCall'
    ) {
      return false;
    }
    const variableDeclaration = parents.get(declaration);
    return variableDeclaration?.type === 'VariableDeclaration'
      && variableDeclaration.kind === 'const'
      && variableDeclaration.declarations.length === 1
      && isDirectProgramExecution(variableDeclaration, parents);
  };

  const hasExactSafeShapeGuard = () => {
    let found = false;
    walk(ast, (node) => {
      if (
        found
        || node.type !== 'IfStatement'
        || !isFailClosedIf(node)
        || !isProgramLevelExecution(node, parents)
      ) {
        return;
      }
      const test = unwrap(node.test);
      if (test?.type !== 'LogicalExpression' || test.operator !== '||') return;
      const comparisons = [test.left, test.right].map((expression) => sourceText(unwrap(expression), source));
      found = comparisons.includes('safeThreshold !== 2n')
        && comparisons.includes('safeOwners.length !== 2');
    });
    return found;
  };

  walk(ast, (node, parent) => {
    if (node.type === 'ImportDeclaration') {
      const importPath = String(node.source.value);
      if (importPath.startsWith('.') && importPath !== './safe-lib.js') {
        addViolation(
          violations,
          'relative-executor-import',
          `${fileName} must not route governance through another relative module`,
        );
      }
      if (importPath === './safe-lib.js') {
        importsHelper = node.specifiers.some(
          (specifier) => specifier.type === 'ImportSpecifier'
            && keyName(specifier.imported) === 'safeExec2of2'
            && specifier.local.name === 'safeExec2of2',
        );
      }
      if (
        importPath === 'node:process'
        && node.specifiers.some((specifier) => (
          specifier.type !== 'ImportSpecifier'
          || keyName(specifier.imported) === 'exit'
        ))
      ) {
        addViolation(
          violations,
          'script-process-exit-alias',
          `${fileName} must use the visible process.exit failure/success boundary`,
        );
      }
    }

    if (
      (node.type === 'VariableDeclarator' && bindingContains(node.id, 'safeExec2of2'))
      || (
        node.type === 'FunctionDeclaration'
        && (
          node.id?.name === 'safeExec2of2'
          || node.params.some((parameter) => bindingContains(parameter, 'safeExec2of2'))
        )
      )
      || (
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
        && node.params.some((parameter) => bindingContains(parameter, 'safeExec2of2'))
      )
      || (node.type === 'CatchClause' && bindingContains(node.param, 'safeExec2of2'))
      || (
        node.type === 'AssignmentExpression'
        && bindingContains(unwrap(node.left), 'safeExec2of2')
      )
      || (
        node.type === 'UpdateExpression'
        && bindingContains(unwrap(node.argument), 'safeExec2of2')
      )
    ) {
      addViolation(
        violations,
        'shadowed-safe-helper',
        `${fileName} must not shadow or replace the imported safeExec2of2 binding`,
      );
    }

    if (
      kind === 'e2e'
      && (
        (
          node.type === 'AssignmentExpression'
          && bindingContains(unwrap(node.left), 'safeCall')
        )
        || (
          node.type === 'UpdateExpression'
          && bindingContains(unwrap(node.argument), 'safeCall')
        )
        || (
          ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)
          && node.params.some((parameter) => bindingContains(parameter, 'safeCall'))
        )
      )
    ) {
      addViolation(
        violations,
        'e2e-wrapper-mutated',
        'The E2E Safe wrapper must be one immutable top-level const binding',
      );
    }

    if (
      node.type === 'AssignmentExpression'
      && isDeploymentsMutationTarget(node.left, variables)
    ) {
      addViolation(
        violations,
        'deploy-manifest-mutation',
        'Deployment output must not be mutated after its verified Safe fields are constructed',
      );
    }
    if (
      node.type === 'AssignmentExpression'
      && ['activation', 'approval'].some((name) => bindingContains(unwrap(node.left), name))
    ) {
      for (const name of ['activation', 'approval']) {
        if (bindingContains(unwrap(node.left), name)) evidenceResultMutations.add(name);
      }
    }
    if (
      node.type === 'UpdateExpression'
      && isDeploymentsMutationTarget(node.argument, variables)
    ) {
      addViolation(
        violations,
        'deploy-manifest-mutation',
        'Deployment output must not be mutated after its verified Safe fields are constructed',
      );
    }
    if (
      node.type === 'UnaryExpression'
      && node.operator === 'delete'
      && isDeploymentsMutationTarget(node.argument, variables)
    ) {
      addViolation(
        violations,
        'deploy-manifest-mutation',
        'Deployment output must not be mutated after its verified Safe fields are constructed',
      );
    }

    if (node.type === 'ObjectExpression') {
      const functionName = objectProperty(node, 'functionName');
      if (functionName && stringValue(functionName.value) === 'execTransaction') {
        addViolation(
          violations,
          'direct-safe-exec',
          'Reproduction scripts must not construct execTransaction directly; use safeExec2of2',
        );
      }
    }

    if (node.type === 'CallExpression') {
      const name = callName(node.callee);
      const callee = unwrap(node.callee);

      if (name === 'exit' && isMember(node.callee, 'process', 'exit')) {
        const argument = unwrap(node.arguments[0]);
        const isFailureExit = argument?.type === 'NumericLiteral' && argument.value !== 0;
        const statement = parents.get(node);
        const directStatement = statement?.type === 'ExpressionStatement'
          ? statement
          : undefined;
        const isFinalSuccessExit = directStatement
          && parents.get(directStatement)?.type === 'Program'
          && ast.program.body.at(-1) === directStatement
          && (
            node.arguments.length === 0
            || (argument?.type === 'NumericLiteral' && argument.value === 0)
          );
        if (!isFailureExit && !isFinalSuccessExit) {
          addViolation(
            violations,
            'script-early-success-exit',
            `${fileName} must not report success before all governance evidence is complete`,
          );
        }
      }

      if (name === 'writeContract') {
        const options = resolveInitializer(node.arguments[0], variables);
        if (
          options?.type === 'ObjectExpression'
          && stringValue(objectProperty(options, 'functionName')?.value) === 'createProxyWithNonce'
        ) {
          const args = unwrap(objectProperty(options, 'args')?.value);
          let scope = node;
          while (scope && !['BlockStatement', 'Program'].includes(scope.type)) {
            scope = parents.get(scope);
          }
          factorySetupUses.push({
            initializer: args?.type === 'ArrayExpression' ? unwrap(args.elements[1]) : undefined,
            scope,
          });
        }
      }

      if (
        name === 'Object.assign'
        || (
          callee?.type === 'MemberExpression'
          && isIdentifier(callee.object, 'Object')
          && keyName(callee.property) === 'assign'
        )
      ) {
        if (node.arguments[0] && isDeploymentsMutationTarget(node.arguments[0], variables)) {
          addViolation(
            violations,
            'deploy-manifest-mutation',
            'Deployment output must not be mutated after its verified Safe fields are constructed',
          );
        }
      }

      if (
        callee?.type === 'MemberExpression'
        && ['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'copyWithin', 'fill']
          .includes(keyName(callee.property))
        && isDeploymentsMutationTarget(callee.object, variables)
      ) {
        addViolation(
          violations,
          'deploy-manifest-mutation',
          'Deployment output must not be mutated after its verified Safe fields are constructed',
        );
      }

      let rawSafeWrite = false;
      let transactionArgument;
      if (name === 'writeContract') {
        transactionArgument = node.arguments[0];
        rawSafeWrite = Boolean(
          node.arguments[0] && objectContainsSafeTarget(node.arguments[0], variables, 'address'),
        );
      } else if (name === 'sendTransaction' || name === 'sendRawTransaction') {
        transactionArgument = node.arguments[0];
        rawSafeWrite = Boolean(
          node.arguments[0] && objectContainsSafeTarget(node.arguments[0], variables, 'to'),
        );
      } else if (name === 'send') {
        transactionArgument = node.arguments[2];
        rawSafeWrite = Boolean(
          node.arguments[2] && objectContainsSafeTarget(node.arguments[2], variables, 'address'),
        );
      } else if (name === 'request') {
        const request = resolveInitializer(node.arguments[0], variables);
        if (request?.type === 'ObjectExpression') {
          const method = stringValue(objectProperty(request, 'method')?.value);
          const params = objectProperty(request, 'params');
          rawSafeWrite = Boolean(
            method?.startsWith('eth_send')
            && params
            && containsSafeTarget(params.value, variables)
          );
        }
      } else if (
        !['readContract', 'simulateContract', 'getCode', 'getBalance', 'encodeFunctionData']
          .includes(name)
      ) {
        rawSafeWrite = node.arguments.some((argument) => (
          objectContainsSafeTarget(argument, variables, 'address')
          || objectContainsSafeTarget(argument, variables, 'to')
        ));
      }
      if (rawSafeWrite || ['execTransaction', 'executeTransaction'].includes(name)) {
        addViolation(
          violations,
          'raw-safe-write',
          'Reproduction scripts must not write to the Safe outside safeExec2of2',
        );
      }
      const governanceAction = transactionArgument
        ? governanceActionInObject(transactionArgument, variables)
        : node.arguments.map((argument) => governanceActionInObject(argument, variables)).find(Boolean);
      if (governanceAction) {
        addViolation(
          violations,
          'direct-governance-write',
          `${governanceAction} must execute only through safeExec2of2`,
        );
      }

      if (name === 'encodeFunctionData') inspectSetup(node);

      if (name === 'safeExec2of2' && callee?.type === 'Identifier') {
        const validLocation = kind === 'e2e'
          ? isE2eWrapperCall(node)
          : isDirectProgramExecution(node, parents);
        if (!validLocation) {
          addViolation(
            violations,
            'nested-safe-helper-call',
            `${fileName} must execute safeExec2of2 directly at program level`,
          );
        } else {
          if (kind !== 'e2e' && parents.get(node)?.type !== 'AwaitExpression') {
            addViolation(
              violations,
              'safe-helper-call-not-awaited',
              `${fileName} must await safeExec2of2 before it can report success`,
            );
          }
          const calldata = unwrap(node.arguments[2]);
          if (
            calldata?.type === 'Identifier'
            && (variableCounts.get(calldata.name) ?? 0) !== 1
          ) {
            addViolation(
              violations,
              'shadowed-governance-calldata',
              `${fileName} must bind governance calldata exactly once`,
            );
          }
          const target = node.arguments[2]
            ? encodedFunctionName(node.arguments[2], variables)
            : undefined;
          helperTargets.push(target);
          if (kind === 'evidence' && ['activateMandate', 'executeEscalated'].includes(target)) {
            let holder = parents.get(node);
            if (holder?.type === 'AwaitExpression') holder = parents.get(holder);
            const declaration = holder?.type === 'VariableDeclarator'
              ? parents.get(holder)
              : undefined;
            const expectedName = target === 'activateMandate' ? 'activation' : 'approval';
            if (
              holder?.type === 'VariableDeclarator'
              && holder.id.type === 'Identifier'
              && holder.id.name === expectedName
              && declaration?.type === 'VariableDeclaration'
              && declaration.kind === 'const'
              && declaration.declarations.length === 1
              && (variableCounts.get(expectedName) ?? 0) === 1
            ) {
              evidenceResultBindings.set(expectedName, holder);
            }
          }
        }
      }

      if (
        kind === 'evidence'
        && name === 'env'
        && stringValue(node.arguments[0])?.startsWith('REUSE_')
      ) {
        evidenceReuseInput = true;
      }

      if (name === 'safeCall' && isDirectProgramExecution(node, parents)) {
        if (parents.get(node)?.type !== 'AwaitExpression') {
          addViolation(
            violations,
            'e2e-safe-call-not-awaited',
            'E2E must await each Safe wrapper execution before reporting success',
          );
        } else {
          const target = stringValue(node.arguments[0]);
          if (target) safeCallTargets.add(target);
        }
      }

      if (kind === 'deploy' && name === 'writeFileSync') {
        const serialized = unwrap(node.arguments[1]);
        if (
          serialized?.type === 'CallExpression'
          && callName(serialized.callee) === 'stringify'
          && isMember(serialized.callee, 'JSON', 'stringify')
          && isIdentifier(serialized.arguments[0], 'deployments')
          && isProgramLevelExecution(node, parents)
        ) {
          deploymentManifestWritten = true;
        }
      }
    }

    if (kind === 'evidence' && node.type === 'AssignmentExpression') {
      const target = sourceText(unwrap(node.left), source);
      const value = unwrap(node.right);
      if (target === 'evidence.mandate' && value?.type === 'ObjectExpression') {
        evidenceActivationRecorded = isIdentifier(
          objectProperty(value, 'activation')?.value,
          'activation',
        );
      }
      if (target === 'evidence.requests' && value?.type === 'ObjectExpression') {
        const escalated = unwrap(objectProperty(value, 'escalated')?.value);
        evidenceApprovalRecorded = escalated?.type === 'ObjectExpression'
          && isIdentifier(objectProperty(escalated, 'approval')?.value, 'approval');
      }
    }

    inspectDeploymentManifest(node);
  });

  if (!importsHelper) {
    addViolation(violations, 'missing-safe-helper-import', `${fileName} must import safeExec2of2`);
  }
  if (helperTargets.length === 0) {
    addViolation(violations, 'missing-safe-helper-call', `${fileName} must execute governance through safeExec2of2`);
  }

  if (kind === 'deploy') {
    if (!setupSeen) addViolation(violations, 'deploy-setup-missing', 'Fresh deployment must encode Safe setup');
    if (
      setupBindings.length !== 1
      || factorySetupUses.length !== 1
      || !setupBindings[0]?.isCanonical
      || !isIdentifier(factorySetupUses[0]?.initializer, 'initializer')
      || setupBindings[0]?.scope !== factorySetupUses[0]?.scope
    ) {
      addViolation(
        violations,
        'deploy-setup-not-used',
        'The exact Safe setup calldata must be the initializer passed to createProxyWithNonce',
      );
    }
    if (!deploymentManifestSeen) {
      addViolation(violations, 'deploy-manifest-missing', 'Fresh deployment must write a Safe manifest');
    }
    if (!deploymentManifestWritten) {
      addViolation(
        violations,
        'deploy-manifest-write',
        'Fresh deployment must serialize the verified deployments object',
      );
    }
    if (!helperTargets.includes('enableModule')) {
      addViolation(violations, 'deploy-enable-not-multisig', 'Module enable must pass enableModule calldata to safeExec2of2');
    }
    if (!hasExactSafeShapeGuard()) {
      addViolation(violations, 'deploy-threshold-not-verified', 'Fresh deployment must verify the on-chain threshold is 2');
      addViolation(violations, 'deploy-owners-not-verified', 'Fresh deployment must verify the on-chain owner count is 2');
      addViolation(
        violations,
        'deploy-safe-shape-guard',
        'Fresh deployment must fail closed on the exact threshold-two and two-owner condition',
      );
    }
  } else if (kind === 'smoke') {
    if (!helperTargets.includes('activateMandate')) {
      addViolation(violations, 'smoke-activation-not-multisig', 'Smoke activation must pass activateMandate calldata to safeExec2of2');
    }
  } else if (kind === 'e2e') {
    if (!helperTargets.includes('$fn')) {
      addViolation(violations, 'e2e-wrapper-not-multisig', 'E2E Safe wrapper must route encoded function calldata to safeExec2of2');
    }
    for (const action of EXPECTED_ACTIONS.e2e) {
      if (!safeCallTargets.has(action)) {
        addViolation(violations, `e2e-${action}-missing`, `E2E must execute ${action} through its Safe wrapper`);
      }
    }
  } else {
    for (const action of EXPECTED_ACTIONS.evidence) {
      if (!helperTargets.includes(action)) {
        addViolation(
          violations,
          `evidence-${action}-not-multisig`,
          `Final evidence must execute and record ${action} through safeExec2of2`,
        );
      }
    }
    if (evidenceReuseInput) {
      addViolation(
        violations,
        'evidence-unverified-reuse',
        'Final evidence must not accept unverified REUSE_* activation placeholders',
      );
    }
    if (
      !evidenceResultBindings.has('activation')
      || evidenceResultMutations.has('activation')
      || !evidenceActivationRecorded
    ) {
      addViolation(
        violations,
        'evidence-activation-not-recorded',
        'Final evidence must record the immutable activation result returned by safeExec2of2',
      );
    }
    if (
      !evidenceResultBindings.has('approval')
      || evidenceResultMutations.has('approval')
      || !evidenceApprovalRecorded
    ) {
      addViolation(
        violations,
        'evidence-approval-not-recorded',
        'Final evidence must record the immutable approval result returned by safeExec2of2',
      );
    }
  }

  return violations;
}

export function auditSafeHelperSource(source, fileName = 'safe-lib.ts') {
  const ast = parseTypeScript(source, fileName);
  const parents = buildParentMap(ast);
  const violations = [];
  const helpers = [];
  let policyImport = false;

  for (const statement of ast.program.body) {
    if (
      statement.type === 'ImportDeclaration'
      && statement.source.value === './lib/safe-policy.mjs'
    ) {
      const names = new Set(
        statement.specifiers
          .filter((specifier) => specifier.type === 'ImportSpecifier')
          .filter((specifier) => specifier.local.name === keyName(specifier.imported))
          .map((specifier) => specifier.local.name),
      );
      policyImport = names.has('assertExact2of2') && names.has('assertTwoSignatures');
    }
  }
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'safeExec2of2') {
      helpers.push(node);
    }
  });

  if (!policyImport) {
    addViolation(
      violations,
      'helper-policy-import',
      'safeExec2of2 must import the exact 2-of-2 policy guards directly',
    );
  }
  if (helpers.length !== 1 || parents.get(helpers[0])?.type !== 'ExportNamedDeclaration') {
    addViolation(
      violations,
      'helper-missing',
      'safe-lib must export exactly one safeExec2of2 function declaration',
    );
  }
  if (helpers.length !== 1) return violations;

  const helper = helpers[0];
  const body = helper.body.body;
  const declarations = new Map();
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      if (declaration.id.type === 'Identifier') {
        declarations.set(declaration.id.name, { declaration, statement });
      }
    }
  }

  const declarationCall = (name, objectName, methodName) => {
    const entry = declarations.get(name);
    if (!entry) return undefined;
    const call = isCall(
      entry.declaration.init,
      (callee) => isMember(callee, objectName, methodName),
    );
    return call ? { ...entry, call } : undefined;
  };
  const declarationFunctionCall = (name, functionName) => {
    const entry = declarations.get(name);
    if (!entry) return undefined;
    const call = isCall(entry.declaration.init, (callee) => isIdentifier(callee, functionName));
    return call ? { ...entry, call } : undefined;
  };
  const assignmentCall = (objectName, methodName) => {
    for (const statement of body) {
      if (statement.type !== 'ExpressionStatement') continue;
      const expression = unwrap(statement.expression);
      if (
        expression?.type !== 'AssignmentExpression'
        || expression.operator !== '='
        || !isIdentifier(expression.left, 'tx')
      ) {
        continue;
      }
      const call = isCall(
        expression.right,
        (callee) => isMember(callee, objectName, methodName),
      );
      if (call) return { statement, call };
    }
    return undefined;
  };

  const safeAInit = declarationCall('safeA', 'Safe', 'init');
  const safeBInit = declarationCall('safeB', 'Safe', 'init');
  const signerFor = (entry) => {
    const options = unwrap(entry?.call.arguments[0]);
    return options?.type === 'ObjectExpression'
      ? sourceText(unwrap(objectProperty(options, 'signer')?.value), source)
      : undefined;
  };
  if (signerFor(safeAInit) !== 'ownerAKey' || signerFor(safeBInit) !== 'ownerBKey') {
    addViolation(
      violations,
      'helper-distinct-signers',
      'safeExec2of2 must initialize owner A and owner B directly from distinct key inputs',
    );
  }

  let stateStatement;
  let stateSourceValid = false;
  for (const statement of body) {
    if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1) continue;
    const declaration = statement.declarations[0];
    if (declaration.id.type !== 'ArrayPattern') continue;
    const names = declaration.id.elements.map((element) => (
      element?.type === 'Identifier' ? element.name : undefined
    ));
    if (names.join(',') !== 'threshold,owners,ownerA,ownerB') continue;
    stateStatement = statement;
    const promiseAll = isCall(
      declaration.init,
      (callee) => isMember(callee, 'Promise', 'all'),
    );
    const reads = unwrap(promiseAll?.arguments[0]);
    const expectedReads = [
      'safeA.getThreshold()',
      'safeA.getOwners()',
      'safeA.getSafeProvider().getSignerAddress()',
      'safeB.getSafeProvider().getSignerAddress()',
    ];
    stateSourceValid = reads?.type === 'ArrayExpression'
      && reads.elements.length === expectedReads.length
      && reads.elements.every(
        (element, index) => sourceText(unwrap(element), source) === expectedReads[index],
      );
  }
  if (!stateStatement || !stateSourceValid) {
    addViolation(
      violations,
      'helper-safe-state-source',
      'safeExec2of2 must read threshold, owners and both signer addresses from the two Safe clients',
    );
  }

  const exactSafe = declarationFunctionCall('exactSafe', 'assertExact2of2');
  const exactSafeOptions = unwrap(exactSafe?.call.arguments[0]);
  const exactSafeArgsValid = exactSafeOptions?.type === 'ObjectExpression'
    && ['threshold', 'owners', 'ownerA', 'ownerB'].every((name) => {
      const property = objectProperty(exactSafeOptions, name);
      return property && isIdentifier(property.value, name);
    });
  if (!exactSafe || !exactSafeArgsValid) {
    addViolation(
      violations,
      'helper-policy-guard-not-direct',
      'safeExec2of2 must directly validate the live Safe state with assertExact2of2',
    );
  }

  const nonce = declarationCall('nonce', 'safeA', 'getNonce');
  const created = declarations.get('tx');
  const createCall = isCall(
    created?.declaration.init,
    (callee) => isMember(callee, 'safeA', 'createTransaction'),
  );
  const createOptions = unwrap(createCall?.arguments[0]);
  const nonceOptions = createOptions?.type === 'ObjectExpression'
    ? unwrap(objectProperty(createOptions, 'options')?.value)
    : undefined;
  const pinnedNonce = nonceOptions?.type === 'ObjectExpression'
    && isIdentifier(objectProperty(nonceOptions, 'nonce')?.value, 'nonce');
  if (!nonce || !created || !createCall || !pinnedNonce) {
    addViolation(
      violations,
      'helper-pinned-nonce-input',
      'safeExec2of2 must read and pin the Safe nonce directly before signing',
    );
  }
  const safeTxHash = declarationCall('safeTxHash', 'safeA', 'getTransactionHash');
  if (!safeTxHash || sourceText(unwrap(safeTxHash.call.arguments[0]), source) !== 'tx') {
    addViolation(
      violations,
      'helper-safe-hash-source',
      'safeExec2of2 must derive the Safe transaction hash from the pinned transaction',
    );
  }

  const signA = assignmentCall('safeA', 'signTransaction');
  const signB = assignmentCall('safeB', 'signTransaction');
  if (stringValue(signA?.call.arguments[1]) !== 'eth_signTypedData_v4') {
    addViolation(violations, 'helper-safeA-eip712', 'safeA must sign with eth_signTypedData_v4');
  }
  if (stringValue(signB?.call.arguments[1]) !== 'eth_signTypedData_v4') {
    addViolation(violations, 'helper-safeB-eip712', 'safeB must sign with eth_signTypedData_v4');
  }

  const confirmations = declarationFunctionCall('confirmations', 'assertTwoSignatures');
  if (
    !confirmations
    || sourceText(unwrap(confirmations.call.arguments[0]), source) !== 'tx.signatures.size'
  ) {
    addViolation(
      violations,
      'helper-policy-guard-not-direct',
      'safeExec2of2 must directly validate the signed transaction with assertTwoSignatures',
    );
  }

  const currentNonce = declarationCall('currentNonce', 'safeA', 'getNonce');
  const exec = declarationCall('exec', 'safeB', 'executeTransaction');
  const executeTxHash = declarations.get('executeTxHash');
  const receipt = declarationCall('receipt', 'publicClient', 'waitForTransactionReceipt');
  if (!exec || sourceText(unwrap(exec.call.arguments[0]), source) !== 'tx') {
    addViolation(
      violations,
      'helper-protocol-execution',
      'safeExec2of2 must directly execute the signed transaction with safeB',
    );
  }
  if (!receipt) {
    addViolation(
      violations,
      'helper-receipt',
      'safeExec2of2 must directly wait for the execution receipt',
    );
  }
  const receiptOptions = unwrap(receipt?.call.arguments[0]);
  const receiptHash = receiptOptions?.type === 'ObjectExpression'
    ? objectProperty(receiptOptions, 'hash')
    : undefined;
  if (
    !executeTxHash
    || sourceText(unwrap(executeTxHash.declaration.init), source) !== 'exec.hash'
    || !receiptHash
    || !isIdentifier(receiptHash.value, 'executeTxHash')
  ) {
    addViolation(
      violations,
      'helper-receipt-hash-source',
      'safeExec2of2 must wait for the receipt whose hash came from the Protocol Kit execution',
    );
  }

  const allIfs = [];
  const allReturns = [];
  const executeCalls = [];
  let rawWriteSeen = false;
  walk(helper, (node, parent) => {
    if (node.type === 'IfStatement') allIfs.push(node);
    if (node.type === 'ReturnStatement') allReturns.push(node);
    if (
      node.type === 'Identifier'
      && ['encodePacked', 'generatePreValidatedSignature'].includes(node.name)
    ) {
      addViolation(
        violations,
        'helper-prevalidated-signature',
        'safeExec2of2 must never construct a pre-validated owner signature',
      );
    }
    if (node.type === 'CallExpression') {
      const name = callName(node.callee);
      if (name === 'executeTransaction') executeCalls.push(node);
      if (
        ['writeContract', 'sendTransaction', 'sendRawTransaction', 'request', 'execTransaction']
          .includes(name)
      ) {
        rawWriteSeen = true;
      }
    }
    if (
      node.type === 'MemberExpression'
      && keyName(node.property) === 'executeTransaction'
      && !(
        parent?.type === 'CallExpression'
        && unwrap(parent.callee) === node
      )
    ) {
      rawWriteSeen = true;
    }
    if (node.type === 'ObjectExpression') {
      const functionName = objectProperty(node, 'functionName');
      if (stringValue(functionName?.value) === 'execTransaction') rawWriteSeen = true;
    }
  });
  if (
    rawWriteSeen
    || executeCalls.length !== 1
    || !exec
    || executeCalls[0] !== exec.call
  ) {
    addViolation(
      violations,
      'helper-raw-write',
      'safeExec2of2 must have exactly one direct Protocol Kit execution and no alternate raw write path',
    );
  }

  const directIfs = body.filter((statement) => statement.type === 'IfStatement');
  const findGuard = (matcher) => directIfs.find((statement) => matcher(statement.test));
  const chainGuard = findGuard((test) => isBinaryGuard(
    test,
    (left) => isIdentifier(left, 'chainId'),
    '!==',
    (right) => isMember(right, 'sepolia', 'id'),
  ));
  const nonceGuard = findGuard((test) => isBinaryGuard(
    test,
    (left) => isIdentifier(left, 'currentNonce'),
    '!==',
    (right) => sourceText(unwrap(right), source) === 'tx.data.nonce',
  ));
  const receiptGuard = findGuard((test) => isBinaryGuard(
    test,
    (left) => isMember(left, 'receipt', 'status'),
    '!==',
    (right) => stringValue(right) === 'success',
  ));
  for (const [code, guard, description] of [
    ['helper-chain-guard-not-fail-closed', chainGuard, 'Sepolia chain'],
    ['helper-nonce-guard-not-fail-closed', nonceGuard, 'pinned nonce'],
    ['helper-receipt-guard-not-fail-closed', receiptGuard, 'successful receipt'],
  ]) {
    if (!guard || !isFailClosedIf(guard)) {
      addViolation(
        violations,
        code,
        `safeExec2of2 must enforce the ${description} with a direct throwing guard`,
      );
    }
  }
  if (
    allIfs.length !== 3
    || directIfs.length !== 3
    || directIfs.some((statement) => ![chainGuard, nonceGuard, receiptGuard].includes(statement))
  ) {
    addViolation(
      violations,
      'helper-unexpected-control-flow',
      'safeExec2of2 must not hide policy or execution behind additional conditional branches',
    );
  }

  const finalReturn = body.at(-1);
  if (
    allReturns.length !== 1
    || finalReturn?.type !== 'ReturnStatement'
    || allReturns[0] !== finalReturn
  ) {
    addViolation(
      violations,
      'helper-early-return',
      'safeExec2of2 must have one unconditional final return after receipt verification',
    );
  }
  const result = unwrap(finalReturn?.argument);
  const returnShapeValid = result?.type === 'ObjectExpression'
    && sourceText(unwrap(objectProperty(result, 'safeTxHash')?.value), source) === 'safeTxHash'
    && sourceText(unwrap(objectProperty(result, 'executeTxHash')?.value), source) === 'executeTxHash'
    && sourceText(unwrap(objectProperty(result, 'nonce')?.value), source) === 'tx.data.nonce'
    && sourceText(unwrap(objectProperty(result, 'confirmations')?.value), source) === 'confirmations'
    && sourceText(unwrap(objectProperty(result, 'threshold')?.value), source) === 'exactSafe.threshold';
  if (!returnShapeValid) {
    addViolation(
      violations,
      'helper-result-shape',
      'safeExec2of2 must return hashes, pinned nonce, verified confirmations and verified threshold',
    );
  }

  const chainId = declarationCall('chainId', 'publicClient', 'getChainId');
  const ordered = [
    chainId?.statement,
    chainGuard,
    safeAInit?.statement,
    safeBInit?.statement,
    stateStatement,
    exactSafe?.statement,
    nonce?.statement,
    created?.statement,
    safeTxHash?.statement,
    signA?.statement,
    signB?.statement,
    confirmations?.statement,
    currentNonce?.statement,
    nonceGuard,
    exec?.statement,
    executeTxHash?.statement,
    receipt?.statement,
    receiptGuard,
    finalReturn,
  ];
  if (
    ordered.some((statement) => !statement)
    || ordered.some((statement, index) => (
      index > 0 && statement.start <= ordered[index - 1].start
    ))
  ) {
    addViolation(
      violations,
      'helper-operation-order',
      'safeExec2of2 must validate, pin, sign twice, recheck, execute, verify and return in order',
    );
  }

  for (const node of [helper, ...body]) {
    if (node !== helper && ['TryStatement', 'SwitchStatement', 'ForStatement', 'ForInStatement',
      'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(node.type)) {
      addViolation(
        violations,
        'helper-unexpected-control-flow',
        'safeExec2of2 must not hide execution behind alternate control flow',
      );
    }
  }

  return violations;
}

export function auditDeploymentManifest(manifest, label) {
  const violations = [];
  const owners = manifest?.safe?.owners;
  if (manifest?.safe?.threshold !== 2) {
    violations.push({ code: `${label}-threshold`, message: `${label} must record Safe threshold 2` });
  }
  if (!Array.isArray(owners) || owners.length !== 2) {
    violations.push({ code: `${label}-owners`, message: `${label} must record exactly two Safe owners` });
  } else if (new Set(owners.map((owner) => String(owner).toLowerCase())).size !== 2) {
    violations.push({ code: `${label}-distinct-owners`, message: `${label} Safe owners must be distinct` });
  }
  return violations;
}
