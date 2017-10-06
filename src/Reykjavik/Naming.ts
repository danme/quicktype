"use strict";

import { Set, OrderedSet, List, Map, Iterable } from "immutable";
import stringHash = require("string-hash");

import { Renderer } from "./Renderer";

export class Namespace {
    private readonly _name: string;
    private readonly _parent?: Namespace;
    private _children: OrderedSet<Namespace>;
    readonly forbidden: Set<Namespace>;
    private _members: OrderedSet<Named>;

    constructor(
        name: string,
        renderer: Renderer,
        parent: Namespace | undefined,
        forbidden: Set<Namespace>
    ) {
        this._name = name;
        this.forbidden = forbidden;
        this._children = OrderedSet();
        this._members = OrderedSet();
        if (parent) {
            this._parent = parent;
            parent.addChild(this);
        }
    }

    private addChild(child: Namespace): void {
        this._children = this._children.add(child);
    }

    get children(): OrderedSet<Namespace> {
        return this._children;
    }

    get members(): OrderedSet<Named> {
        return this._members;
    }

    add(named: Named): void {
        this._members = this._members.add(named);
    }

    equals(other: any): boolean {
        return this === other;
    }

    hashCode(): number {
        let hash = stringHash(this._name);
        if (this._parent) {
            hash += this._parent.hashCode();
        }
        return hash | 0;
    }
}

// Naming functions are invoked when there are conflicts between names.  Those
// arise under two circumstances, which can also combine:
//
// 1. A proposed name is the same as an already assigned name that's forbidden
//    for the name to be assigned.
// 2. There is more than one Named about to be assigned a name that all have
//    the same proposed name.
//
// The naming function is invoked with the set of all assigned, forbidden names,
// the requested name, and the number of names to generate.
//
// NamingFunction is a class so that we can compare naming functions and put
// them into immutable collections.

abstract class NamingFunction {
    abstract name(
        proposedName: string,
        forbiddenNames: Set<string>,
        numberOfNames: number
    ): OrderedSet<string>;

    abstract equals(other: any): boolean;
    abstract hashCode(): number;
}

export abstract class Named {
    readonly namespace: Namespace;
    readonly name: string;
    // If a Named is fixed, this is null.
    readonly namingFunction: NamingFunction | null;

    constructor(
        namespace: Namespace,
        name: string,
        namingFunction: NamingFunction | null
    ) {
        this.namespace = namespace;
        this.name = name;
        this.namingFunction = namingFunction;
        namespace.add(this);
    }

    equals(other: any): boolean {
        return this === other;
    }

    hashCode(): number {
        return (stringHash(this.name) + this.namespace.hashCode()) | 0;
    }

    abstract get dependencies(): List<Named>;

    get isFixed(): boolean {
        return this.namingFunction === null;
    }

    abstract proposeName(names: Map<Named, string>): string;
}

export class FixedNamed extends Named {
    constructor(namespace: Namespace, name: string) {
        super(namespace, name, null);
    }

    get dependencies(): List<Named> {
        return List();
    }

    proposeName(names: Map<Named, string>): string {
        return this.name;
    }
}

export class SimpleNamed extends Named {
    // It makes sense for this to be different from the name.  For example, the
    // name for the top-level should be something like "TopLevel", but its
    // preferred name could be "QuickType" or "Pokedex".  Also, once we allow
    // users to override names, the overridden name will be the preferred.  We
    // need to ensure no collisions, so we can't just hard override (unless we
    // still check for collisions and just error if there are any).
    private readonly _proposed: string;

    constructor(
        namespace: Namespace,
        name: string,
        namingFunction: NamingFunction,
        proposed: string
    ) {
        super(namespace, name, namingFunction);
        this._proposed = proposed;
    }

    get dependencies(): List<Named> {
        return List();
    }

    proposeName(names: Map<Named, string>): string {
        return this._proposed;
    }
}

export class DependencyNamed extends Named {
    // This is a List as opposed to a set because it might contain the same
    // name more than once, and we don't want to put the burden of checking
    // on the renderer.
    private readonly _dependencies: List<Named>;
    // The `names` parameter will contain the names of all `dependencies` in
    // the same order as the latter.  If some of them are the same, `names`
    // will contain their names multiple times.
    private readonly _proposeName: (names: List<string>) => string;

    constructor(
        namespace: Namespace,
        name: string,
        namingFunction: NamingFunction,
        dependencies: List<Named>,
        proposeName: (names: List<string>) => string
    ) {
        super(namespace, name, namingFunction);
        this._dependencies = dependencies;
        this._proposeName = proposeName;
    }

    get dependencies(): List<Named> {
        return this._dependencies;
    }

    proposeName(names: Map<Named, string>): string {
        const dependencyNames = this._dependencies
            .map(n => names.get(n))
            .toList();
        return this._proposeName(dependencyNames);
    }
}

function allNamespacesRecursively(
    namespaces: OrderedSet<Namespace>
): OrderedSet<Namespace> {
    return namespaces.union(
        ...namespaces.map(ns => allNamespacesRecursively(ns.children)).toArray()
    );
}

class NamingContext {
    names: Map<Named, string> = Map();
    namedsForName: Map<string, Set<Named>> = Map();
    readonly namespaces: OrderedSet<Namespace>;

    constructor(rootNamespaces: OrderedSet<Namespace>) {
        this.namespaces = allNamespacesRecursively(rootNamespaces);
    }

    isReadyToBeNamed = (named: Named): boolean => {
        if (this.names.has(named)) return false;
        return named.dependencies.every(n => this.names.has(n));
    };

    isFullyNamed = (namespace: Namespace): boolean => {
        return namespace.members.every(n => this.names.has(n));
    };

    isConflicting = (named: Named, proposed: string): boolean => {
        if (!this.namedsForName.has(proposed)) return false;
        let conflicting: Named | undefined;
        this.namedsForName.get(proposed).forEach(n => {
            if (
                named.namespace.equals(n.namespace) ||
                named.namespace.forbidden.has(n.namespace)
            ) {
                conflicting = n;
                return false;
            }
        });
        return !!conflicting;
    };

    assign = (named: Named, name: string): void => {
        if (this.names.has(named)) {
            throw "Named assigned twice";
        }
        if (this.isConflicting(named, name)) {
            throw "Assigned name conflicts";
        }
        this.names = this.names.set(named, name);
        if (!this.namedsForName.has(name)) {
            this.namedsForName.set(name, Set());
        }
        this.namedsForName.get(name).add(named);
    };
}

function orderedSetUnion<T>(sets: Iterable<any, OrderedSet<T>>): OrderedSet<T> {
    const setArray = sets.toArray();
    if (setArray.length === 0) return OrderedSet();
    if (setArray.length === 1) return setArray[0];
    return setArray[0].union(...setArray.slice(1));
}

// Naming algorithm
function assignNames(
    rootNamespaces: OrderedSet<Namespace>
): Map<Named, string> {
    const ctx = new NamingContext(rootNamespaces);

    // Assign all fixed names.
    const fixedNames = ctx.namespaces.flatMap(ns =>
        ns.members.filter(n => n.isFixed)
    );
    fixedNames.forEach(n => {
        const name = n.proposeName(null);
        ctx.assign(n, name);
    });

    for (;;) {
        // 1. Find a namespace whose forbiddens are all fully named, and which has
        //    at least one unnamed Named that has all its dependencies satisfied.
        //    If no such namespace exists we're either done, or there's an unallowed
        //    cycle.

        const unfinishedNamespaces = ctx.namespaces.filter(ctx.isFullyNamed);
        const readyNamespace = unfinishedNamespaces.find(ns =>
            ns.members.some(ctx.isReadyToBeNamed)
        );

        if (!readyNamespace) {
            // FIXME: Check for cycles?
            return ctx.names;
        }

        const forbiddenNameds = orderedSetUnion(
            readyNamespace.forbidden.map(ns => ns.members)
        );
        const forbiddenNames = forbiddenNameds
            .map(n => ctx.names.get(n))
            .toSet();

        // 2. Sort those names into sets where all members of a set propose the same
        //    name and have the same naming function.

        const readyNames = readyNamespace.members.filter(ctx.isReadyToBeNamed);
        // It would be nice if we had tuples, then we wouldn't have to do this in
        // two steps.
        const byNamingFunction = readyNames.groupBy(n => n.namingFunction);
        byNamingFunction.forEach((nameds, namingFunction) => {
            const byProposed = nameds.groupBy(n => n.proposeName(ctx.names));
            byProposed.forEach((nameds, proposed) => {
                // 3. Use each set's naming function to name its members.

                const numNames = nameds.size;
                const names = namingFunction.name(
                    proposed,
                    forbiddenNames,
                    numNames
                );
                const namedsArray = nameds.toArray();
                const namesArray = names.toArray();
                if (namesArray.length !== numNames) {
                    throw "Naming function returned wrong number of names";
                }
                for (let i = 0; i < numNames; i++) {
                    const named = namedsArray[i];
                    const name = namesArray[i];
                    ctx.assign(named, name);
                }
            });
        });
    }
}