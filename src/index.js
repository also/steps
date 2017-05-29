/* @flow */

type Step<A, R> = {|
  type: 'step',
  name: string,
  fn: A => Promise<R>,

  next?: StepOrBranch<R, any>
|};

type Branches<A> = {[key: string]: StepOrBranch<A, *>};
// https://github.com/prettier/prettier/issues/1813
// prettier-ignore
type ExtractStepType = <A>(FlowFirst<A, *>) => StepOrBranch<A, *>;
// TODO if the value type is FlowFirst<A, *> things get really weird
type BranchesFirst<A> = {[key: string]: FlowFirst<A, any>};

type BranchResult<B, R> = {edge: $Keys<B>, value: R};

type _Branch<A, B: Branches<A>, R> = {|
  type: 'branch',
  name: string,
  fn: A => Promise<BranchResult<B, R>>,
  branches: B
|};

type Branch<A, R> = _Branch<A, Branches<A>, R>;

export type StepOrBranch<A, R> = Step<A, R> | Branch<A, R>;

export type Builder<A> = {
  first: Step<A, any>
};

export type EmptyBuilder = {
  next: <A, R>(step: Step<A, R>) => StepBuilder<A, R>,
  step: <A, R>(name: string, fn: (A) => Promise<R>) => StepBuilder<A, R>,
  step0: <A, R>(name: string, fn: (R) => any) => StepBuilder<A, R>
};

export type StepBuilder<A, R> = Builder<A> & {
  last: Step<any, R>,
  step: <R2>(name: string, fn: (R) => Promise<R2>) => StepBuilder<A, R2>,
  next: <R2>(step: Step<R, R2>) => StepBuilder<A, R2>,
  step0: (name: string, fn: (R) => any) => StepBuilder<A, R>,
  branch: <R2, B: BranchesFirst<R2>>(
    name: string,
    next: B,
    fn: (R) => Promise<BranchResult<$ObjMap<B, ExtractStepType>, R2>>
  ) => Builder<A>
};

// something you can step into
export type FlowFirst<A, R> = StepOrBranch<A, R> | Builder<A>;
// something you can step out of
export type FlowLast<A, R> = Step<A, R> | StepBuilder<A, R>;

export function branch<A, B: BranchesFirst<A>, R>(
  name: string,
  branches: B,
  fn: A => Promise<BranchResult<$ObjMap<B, ExtractStepType>, R>>
): Branch<A, R> {
  return {
    type: 'branch',
    name,
    fn,
    branches: branchesFirst(branches)
  };
}

export function step0<A>(name: string, fn: A => any): Step<A, A> {
  return step(name, async a => (await fn(a), a));
}

export function step<A, R>(name: string, fn: A => Promise<R>): Step<A, R> {
  return {
    type: 'step',
    name,
    fn
  };
}

export function join<R>(a: FlowLast<*, R>, b: FlowFirst<R, *>) {
  const l = last(a);
  if (l.next) {
    throw new Error(`step "${l.name}" already has next step "${l.next.name}"`);
  }

  l.next = first(b);
}

const builderBase = {
  step(name, fn) {
    return this.next(step(name, fn));
  },

  step0(name, fn) {
    return this.next(step0(name, fn));
  }
};

function stepBuilder<A, R>(first: Step<A, *>, last: Step<*, R>): StepBuilder<A, R> {
  return {
    first,
    last,

    next<R2>(s: Step<R, R2>): StepBuilder<A, R2> {
      join(last, s);
      return stepBuilder(first, s);
    },

    branch<R2, B: BranchesFirst<R2>>(
      name: string,
      branches: B,
      fn: R => Promise<BranchResult<$ObjMap<B, ExtractStepType>, R2>>
    ): Builder<A> {
      const b: Branch<R, R2> = branch(name, branches, fn);
      join(last, b);
      return {
        first
      };
    },
    ...builderBase
  };
}

export function builder(): EmptyBuilder {
  return {
    next<A, R>(step: Step<A, R>): StepBuilder<A, R> {
      return stepBuilder(step, step);
    },
    ...builderBase
  };
}

function first<A>(s: FlowFirst<A, *>): StepOrBranch<A, *> {
  if (s.first) {
    return s.first;
  } else {
    return s;
  }
}

function branchesFirst<A, B: BranchesFirst<A>>(b: B): $ObjMap<B, ExtractStepType> {
  return Object.keys(b).reduce((acc, k) => Object.assign(acc, {[k]: first(b[k])}), {});
}

function last<R>(s: FlowLast<*, R>): Step<*, R> {
  if (s.last) {
    return s.last;
  } else {
    return s;
  }
}

export async function run<A>(flow: FlowFirst<A, *>, arg: A): any {
  let step = first(flow);
  while (step) {
    console.log(`--> ${step.name}`);
    if (step.type === 'branch') {
      const branch = await step.fn(arg);
      step = step.branches[branch.edge];
      arg = branch.value;
    } else {
      arg = await step.fn(arg);
      step = step.next;
    }
    console.log();
  }
  return arg;
}

type Edge = {
  type: 'edge',
  name: string,
  from: StepOrBranch<*, *>,
  to: StepOrBranch<*, *>
};

export function* iterator(flow: FlowFirst<*, *>): Generator<StepOrBranch<*, *> | Edge, void, void> {
  const visited = new Set();
  const q: Array<StepOrBranch<*, *>> = [first(flow)];

  while (q.length > 0) {
    const step = q.pop();
    yield step;
    if (step.type === 'branch') {
      for (const k of Object.keys(step.branches)) {
        const branch = step.branches[k];
        yield {
          type: 'edge',
          name: k,
          from: step,
          to: branch
        };
        if (!visited.has(branch)) {
          q.push(branch);
        }
      }
    } else {
      const next = step.next;
      if (next) {
        yield {
          type: 'edge',
          name: 'next',
          from: step,
          to: next
        };
        if (!visited.has(next)) {
          q.push(next);
        }
      }
    }
  }
}
