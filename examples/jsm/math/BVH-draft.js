import { Box3, Line3, Plane, Triangle, Vector3, Layers } from "three";
import { Capsule } from "three/examples/jsm/math/Capsule.js";

const _v1 = new Vector3();
const _plane = new Plane();
const _line1 = new Line3();
const _line2 = new Line3();
const _point1 = new Vector3();
const _point2 = new Vector3();
const _temp1 = new Vector3();
const _temp2 = new Vector3();
const _temp3 = new Vector3();
const EPS = 1e-10;
const _capsule = new Capsule();
const _vCapsule = new Vector3();

class BVH {
	constructor(triangles = []) {
		this.box = new Box3();
		this.triangles = triangles;
		this.left = null;
		this.right = null;
		this.layers = new Layers();

		this.updateBoundingBox();
	}

	updateBoundingBox() {
		this.box.makeEmpty();
		for (let i = 0; i < this.triangles.length; i++) {
			this.box.expandByPoint(this.triangles[i].a);
			this.box.expandByPoint(this.triangles[i].b);
			this.box.expandByPoint(this.triangles[i].c);
		}
	}

	build(maxLeafTriangles = 10, depth = 0, maxDepth = 20) {
		if (this.triangles.length <= maxLeafTriangles || depth >= maxDepth) {
			// Leaf node
			return;
		}

		// Choose axis to split
		const extent = new Vector3();
		extent.subVectors(this.box.max, this.box.min);

		let axis = 0;
		if (extent.y > extent.x) axis = 1;
		if (extent.z > extent.y && extent.z > extent.x) axis = 2;

		// Sort the triangles based on the center along the axis
		this.triangles.sort((a, b) => {
			const centerA = new Vector3()
				.addVectors(a.a, a.b)
				.add(a.c)
				.multiplyScalar(1 / 3);
			const centerB = new Vector3()
				.addVectors(b.a, b.b)
				.add(b.c)
				.multiplyScalar(1 / 3);
			return centerA.getComponent(axis) - centerB.getComponent(axis);
		});

		// Split the triangles
		const mid = Math.floor(this.triangles.length / 2);
		const leftTriangles = this.triangles.slice(0, mid);
		const rightTriangles = this.triangles.slice(mid);

		// Create child nodes
		this.left = new BVH(leftTriangles);
		this.left.build(maxLeafTriangles, depth + 1, maxDepth);

		this.right = new BVH(rightTriangles);
		this.right.build(maxLeafTriangles, depth + 1, maxDepth);

		// Clear triangles from this node
		this.triangles = null;
	}

	fromGraphNode(group) {
		const triangles = [];

		group.updateWorldMatrix(true, true);

		group.traverse((obj) => {
			if (obj.isMesh === true) {
				if (this.layers.test(obj.layers)) {
					let geometry = obj.geometry;

					let isTemp = false;
					if (geometry.index !== null) {
						isTemp = true;
						geometry = geometry.toNonIndexed();
					}

					const positionAttribute = geometry.getAttribute("position");

					for (let i = 0; i < positionAttribute.count; i += 3) {
						const v1 = new Vector3().fromBufferAttribute(positionAttribute, i);
						const v2 = new Vector3().fromBufferAttribute(
							positionAttribute,
							i + 1
						);
						const v3 = new Vector3().fromBufferAttribute(
							positionAttribute,
							i + 2
						);

						v1.applyMatrix4(obj.matrixWorld);
						v2.applyMatrix4(obj.matrixWorld);
						v3.applyMatrix4(obj.matrixWorld);

						const triangle = new Triangle(v1, v2, v3);
						triangles.push(triangle);
					}

					if (isTemp) {
						geometry.dispose();
					}
				}
			}
		});

		this.triangles = triangles;
		this.updateBoundingBox();
		this.build();

		return this;
	}

	// Capsule intersection with depth and normal
	capsuleIntersect(capsule) {
		_capsule.copy(capsule);

		const collisions = this._capsuleIntersectNode(_capsule, this);

		if (collisions.length === 0) return false;

		let hit = false;

		for (let i = 0; i < collisions.length; i++) {
			const collision = collisions[i];
			hit = true;

			_capsule.translate(
				collision.normal.clone().multiplyScalar(collision.depth)
			);
		}

		if (hit) {
			const collisionVector = _capsule
				.getCenter(_vCapsule)
				.sub(capsule.getCenter(_v1));
			const depth = collisionVector.length();

			return { normal: collisionVector.normalize(), depth: depth };
		}

		return false;
	}

	_capsuleIntersectNode(capsule, node) {
		if (!capsule.intersectsBox(node.box)) {
			return [];
		}

		if (node.left === null && node.right === null) {
			// Leaf node
			let collisions = [];
			for (let i = 0; i < node.triangles.length; i++) {
				const collision = this.triangleCapsuleIntersect(
					capsule,
					node.triangles[i]
				);
				if (collision) {
					collisions.push(collision);
				}
			}
			return collisions;
		} else {
			// Inner node
			let collisions = [];
			if (node.left)
				collisions = collisions.concat(
					this._capsuleIntersectNode(capsule, node.left)
				);
			if (node.right)
				collisions = collisions.concat(
					this._capsuleIntersectNode(capsule, node.right)
				);
			return collisions;
		}
	}

	triangleCapsuleIntersect(capsule, triangle) {
		triangle.getPlane(_plane);

		const d1 = _plane.distanceToPoint(capsule.start) - capsule.radius;
		const d2 = _plane.distanceToPoint(capsule.end) - capsule.radius;

		if ((d1 > 0 && d2 > 0) || (d1 < -capsule.radius && d2 < -capsule.radius)) {
			return false;
		}

		const delta = Math.abs(d1 / (Math.abs(d1) + Math.abs(d2)));
		const intersectPoint = _v1.copy(capsule.start).lerp(capsule.end, delta);

		if (triangle.containsPoint(intersectPoint)) {
			return {
				normal: _plane.normal.clone(),
				point: intersectPoint.clone(),
				depth: Math.abs(Math.min(d1, d2)),
			};
		}

		const r2 = capsule.radius * capsule.radius;

		_line1.set(capsule.start, capsule.end);

		const edges = [
			[triangle.a, triangle.b],
			[triangle.b, triangle.c],
			[triangle.c, triangle.a],
		];

		for (let i = 0; i < edges.length; i++) {
			_line2.set(edges[i][0], edges[i][1]);

			this.lineToLineClosestPoints(_line1, _line2, _point1, _point2);

			if (_point1.distanceToSquared(_point2) < r2) {
				return {
					normal: _point1.clone().sub(_point2).normalize(),
					point: _point2.clone(),
					depth: capsule.radius - _point1.distanceTo(_point2),
				};
			}
		}

		return false;
	}

	lineToLineClosestPoints(line1, line2, target1, target2) {
		const r = _temp1.copy(line1.end).sub(line1.start);
		const s = _temp2.copy(line2.end).sub(line2.start);
		const w = _temp3.copy(line1.start).sub(line2.start);

		const a = r.dot(r);
		const b = r.dot(s);
		const c = s.dot(s);
		const d = r.dot(w);
		const e = s.dot(w);

		const denominator = a * c - b * b;

		let sc, tc;

		if (denominator < EPS) {
			// Lines are nearly parallel
			sc = 0.0;
			tc = b > c ? d / b : e / c;
		} else {
			sc = (b * e - c * d) / denominator;
			tc = (a * e - b * d) / denominator;
		}

		sc = Math.max(0, Math.min(1, sc));
		tc = Math.max(0, Math.min(1, tc));

		target1.copy(line1.start).add(r.multiplyScalar(sc));
		target2.copy(line2.start).add(s.multiplyScalar(tc));
	}
}

export { BVH };
