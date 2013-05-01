var DU = require('./mediawiki.DOMUtils.js').DOMUtils;

/**
 * A DOM diff helper class
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 */
function DOMDiff ( env ) {
	this.env = env;
	this.debugging = env.conf.parsoid.debug ||
		(env.conf.parsoid.traceFlags && env.conf.parsoid.traceFlags.indexOf('selser') !== -1);
	this.debug = this.debugging ? console.log : function(){};
}

var DDP = DOMDiff.prototype;

/**
 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
 * change information.
 */
DDP.diff = function ( node ) {
	// work on a cloned copy of the passed-in node
	var workNode = node.cloneNode(true);

	// SSS FIXME: Is this required?
	//
	// First do a quick check on the top-level nodes themselves
	if (!this.treeEquals(this.env.page.dom, workNode, false)) {
		this.markNode(workNode, 'modified');
		return { isEmpty: false, dom: workNode };
	}

	// The root nodes are equal, call recursive differ
	var foundChange = this.doDOMDiff(this.env.page.dom, workNode);
	this.debug('ORIG:\n', this.env.page.dom.outerHTML, '\nNEW :\n', workNode.outerHTML );
	return { isEmpty: ! foundChange, dom: workNode };
};

// These attributes are ignored for equality purposes if they are added to a
// node.
var ignoreAttributes = {
	// Do our own full diff for now, so ignore data-ve-changed info.
	'data-ve-changed': 1,
	// SSS FIXME: parsoidTests.js adds this flag on a node when nothing in the
	// subtree actually changes.  So, ignoring this attribute in effect,
	// ignores the parser tests change.
	'data-parsoid-changed': 1,
	// SSS: Don't ignore data-parsoid because in VE, sometimes wrappers get
	// moved around without their content which occasionally leads to incorrect
	// DSR being used by selser.  Hard to describe a reduced test case here.
	// Discovered via: /mnt/bugs/2013-05-01T09:43:14.960Z-Reverse_innovation
	// 'data-parsoid': 1,
	'data-parsoid-diff': 1,
	'about': 1
};

/**
 * Attribute equality test
 */
DDP.attribsEquals = function(nodeA, nodeB) {
	function arrayToHash(attrs) {
		var h = {}, count = 0;
		for (var i = 0, n = attrs.length; i < n; i++) {
			var a = attrs.item(i);
			if (!ignoreAttributes[a.name]) {
				count++;
				h[a.name] = a.value;
			}
		}

		return { h: h, count: count };
	}

	var xA = arrayToHash(nodeA.attributes),
		xB = arrayToHash(nodeB.attributes);

	if (xA.count !== xB.count) {
		return false;
	}

	var hA = xA.h, keysA = Object.keys(hA).sort(),
		hB = xB.h, keysB = Object.keys(hB).sort();

	for (var i = 0; i < xA.count; i++) {
		var k = keysA[i];
		if (k !== keysB[i] || hA[k] !== hB[k]) {
			return false;
		}
	}

	return true;
};


/**
 * Test if two DOM nodes are equal without testing subtrees
 */
DDP.treeEquals = function (nodeA, nodeB, deep) {
	if ( nodeA.nodeType !== nodeB.nodeType ) {
		return false;
	} else if (nodeA.nodeType === nodeA.TEXT_NODE ||
			nodeA.nodeType === nodeA.COMMENT_NODE)
	{
		// In the past we've had bugs where we let non-primitive strings
		// leak into our DOM.  Safety first:
		console.assert(nodeA.nodeValue === nodeA.nodeValue.valueOf());
		console.assert(nodeB.nodeValue === nodeB.nodeValue.valueOf());
		// ok, now do the comparison.
		return nodeA.nodeValue === nodeB.nodeValue;
	} else if (nodeA.nodeType === nodeA.ELEMENT_NODE) {
		// Compare node name and attribute length
		if (nodeA.nodeName !== nodeB.nodeName || !this.attribsEquals(nodeA, nodeB)) {
			return false;
		}

		// Passed all tests, element node itself is equal.
		if ( deep ) {
			// Compare children too
			if (nodeA.childNodes.length !== nodeB.childNodes.length) {
				return false;
			}
			var childA = nodeA.firstChild,
				childB = nodeB.firstChild;
			while(childA) {
				if (!this.treeEquals(childA, childB, deep)) {
					return false;
				}
				childA = childA.nextSibling;
				childB = childB.nextSibling;
			}
		}

		// Did not find a diff yet, so the trees must be equal.
		return true;
	}
};


/**
 * Diff two DOM trees by comparing them node-by-node
 *
 * TODO: Implement something more intelligent like
 * http://gregory.cobena.free.fr/www/Publications/%5BICDE2002%5D%20XyDiff%20-%20published%20version.pdf,
 * which uses hash signatures of subtrees to efficiently detect moves /
 * wrapping.
 *
 * Adds / updates a data-parsoid-diff structure with change information.
 *
 * Returns true if subtree is changed, false otherwise.
 *
 * TODO:
 * Assume typical CSS white-space, so ignore ws diffs in non-pre content.
 */
DDP.doDOMDiff = function ( baseParentNode, newParentNode ) {
	var dd = this;

	function debugOut(nodeA, nodeB, laPrefix) {
		laPrefix = laPrefix || "";
		if (dd.debugging) {
			dd.debug("--> A" + laPrefix + ":" + (DU.isElt(nodeA) ? nodeA.outerHTML : JSON.stringify(nodeA.nodeValue)));
			dd.debug("--> B" + laPrefix + ":" + (DU.isElt(nodeB) ? nodeB.outerHTML : JSON.stringify(nodeB.nodeValue)));
		}
	}

	// Perform a relaxed version of the recursive treeEquals algorithm that
	// allows for some minor differences and tries to produce a sensible diff
	// marking using heuristics like look-ahead on siblings.
	var baseNode = baseParentNode.firstChild,
		newNode = newParentNode.firstChild,
		lookaheadNode = null,
		foundDiffOverall = false;

	while ( baseNode && newNode ) {
		debugOut(baseNode, newNode);
		if ( ! this.treeEquals(baseNode, newNode, false) ) {
			this.debug("-- not equal --");
			var origNode = newNode,
				foundDiff = false;

			// Some simplistic look-ahead, currently limited to a single level
			// in the DOM.

			// look-ahead in *new* DOM to detect insertions
			if (DU.isContentNode(baseNode)) {
				this.debug("--lookahead in new dom--");
				lookaheadNode = newNode.nextSibling;
				while (lookaheadNode) {
					debugOut(baseNode, lookaheadNode, "new");
					if (DU.isContentNode(lookaheadNode) &&
						this.treeEquals(baseNode, lookaheadNode, true))
					{
						// mark skipped-over nodes as inserted
						var markNode = newNode;
						while (markNode !== lookaheadNode) {
							this.debug("--found diff: inserted--");
							this.markNode(markNode, 'inserted');
							markNode = markNode.nextSibling;
						}
						foundDiff = true;
						newNode = lookaheadNode;
						break;
					}
					lookaheadNode = lookaheadNode.nextSibling;
				}
			}

			// look-ahead in *base* DOM to detect deletions
			if (!foundDiff && DU.isContentNode(newNode)) {
				this.debug("--lookahead in old dom--");
				lookaheadNode = baseNode.nextSibling;
				while (lookaheadNode) {
					debugOut(lookaheadNode, newNode, "old");
					if (DU.isContentNode(lookaheadNode) &&
						this.treeEquals(lookaheadNode, newNode, true))
					{
						this.debug("--found diff: deleted--");
						// TODO: treat skipped-over nodes as deleted
						// insertModificationMarker
						//console.log('inserting deletion mark before ' + newNode.outerHTML);
						this.markNode(newNode, 'deleted');
						baseNode = lookaheadNode;
						foundDiff = true;
						break;
					}
					lookaheadNode = lookaheadNode.nextSibling;
				}
			}

			if (!foundDiff) {
				if (origNode.nodeName === baseNode.nodeName) {
					// Identical wrapper-type, but modified.
					// Mark as modified, and recurse.
					this.markNode(origNode, 'modified-wrapper');
					this.doDOMDiff(baseNode, origNode);
				} else {
					// Mark the sub-tree as modified since
					// we have two entirely different nodes here
					this.markNode(origNode, 'modified');
				}
			}

			foundDiffOverall = true;
		} else if (!DU.isTplElementNode(this.env, newNode)) {
			// Recursively diff subtrees if not template-like content
			var subtreeDiffers = this.doDOMDiff(baseNode, newNode);
			if (subtreeDiffers) {
				this.markNode(newNode, 'subtree-changed');
			}
			foundDiffOverall = subtreeDiffers || foundDiffOverall;
		}

		// And move on to the next pair
		baseNode = baseNode.nextSibling;
		newNode = newNode.nextSibling;
	}

	// mark extra new nodes as modified
	while (newNode) {
		this.debug("--found trailing new node: inserted--");
		this.markNode(newNode, 'inserted');
		foundDiffOverall = true;
		newNode = newNode.nextSibling;
	}

	// If there are extra base nodes, something was deleted. Mark the parent as
	// having lost children for now.
	if (baseNode) {
		this.debug("--found trailing base nodes: deleted--");
		this.markNode(newParentNode, 'deleted-child');
		foundDiffOverall = true;
	}

	return foundDiffOverall;
};


/******************************************************
 * Helpers
 *****************************************************/

DDP.markNode = function(node, change) {
	if ( change === 'deleted' ) {
		// insert a meta tag marking the place where content used to be
		DU.prependTypedMeta(node, 'mw:DiffMarker');
	} else {
		if (node.nodeType === node.ELEMENT_NODE) {
			DU.setDiffMark(node, this.env, change);
		} else if (node.nodeType !== node.TEXT_NODE && node.nodeType !== node.COMMENT_NODE) {
			console.error('ERROR: Unhandled node type ' + node.nodeType + ' in markNode!');
			console.trace();
			return;
		}
	}
};

if (typeof module === "object") {
	module.exports.DOMDiff = DOMDiff;
}
