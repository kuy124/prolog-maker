/**
 * Example rooms.
 *
 * Each one is a small program that demonstrates something the engine does well,
 * chosen so that a first-time visitor can press Run without reading anything
 * first. They are also the test corpus: the end-to-end suite opens each one and
 * runs its goal, so an example that stops working fails a test rather than
 * disappointing a visitor.
 */

export interface Example {
  id: string;
  name: string;
  description: string;
  program: string;
  /** A goal that shows the example off, pre-filled in the console. */
  goal: string;
}

export const EXAMPLES: Example[] = [
  {
    id: 'family',
    name: 'Family tree',
    description: 'Facts and a recursive rule. Ask who is an ancestor of whom.',
    program: `% A family tree. Facts are just clauses, so edit them here like any other.

parent(ada, bo).
parent(bo, cy).
parent(cy, dee).
parent(ada, eli).

grandparent(X, Z) :-
    parent(X, Y),
    parent(Y, Z).

ancestor(X, Z) :-
    parent(X, Z).
ancestor(X, Z) :-
    parent(X, Y),
    ancestor(Y, Z).
`,
    goal: 'ancestor(ada, Who).',
  },
  {
    id: 'lists',
    name: 'List basics',
    description: 'Member, append and length, on the built-in list library.',
    program: `% Lists are built in. Nothing needs importing for these.

siblings(A, B) :-
    parent(P, A),
    parent(P, B),
    A \\== B.

parent(ada, bo).
parent(ada, eli).
parent(bo, cy).
`,
    goal: 'siblings(A, B).',
  },
  {
    id: 'queens',
    name: 'Eight queens',
    description: 'A classic search problem. The first solution arrives at once.',
    program: `% Eight queens, written with select/3 and no library beyond lists.

queens(N, Qs) :-
    numlist(1, N, Ns),
    permutation(Ns, Qs),
    safe(Qs).

safe([]).
safe([Q|Qs]) :-
    safe(Qs),
    no_attack(Q, Qs, 1).

no_attack(_, [], _).
no_attack(Q, [Q1|Qs], D) :-
    Q =\\= Q1 + D,
    Q =\\= Q1 - D,
    D1 is D + 1,
    no_attack(Q, Qs, D1).
`,
    goal: 'queens(8, Qs).',
  },
  {
    id: 'grammar',
    name: 'A tiny grammar',
    description: 'Definite clause grammars, which are ordinary Prolog underneath.',
    program: `% A DCG. The --> operator expands into a difference list.

sentence --> noun_phrase, verb_phrase.

noun_phrase --> determiner, noun.
noun_phrase --> determiner, adjective, noun.

verb_phrase --> verb.
verb_phrase --> verb, noun_phrase.

determiner --> [the].
determiner --> [a].

adjective --> [small].
adjective --> [green].

noun --> [cat].
noun --> [dog].
noun --> [house].

verb --> [sees].
verb --> [chases].
`,
    goal: 'phrase(sentence, [the, small, cat, chases, a, dog], []).',
  },
];

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((example) => example.id === id);
}
