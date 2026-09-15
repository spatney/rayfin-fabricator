import { describe, expect, it } from 'vitest'
import type { ModelRelation } from './parseSchema'
import {
  computeEdgeGeometry,
  deriveRelationEdges,
  type AnchorFn,
  type Pt,
  type RectLike
} from './relationships'
import { segmentHitsRect } from './router'

const rel = (
  from: string,
  to: string,
  kind: ModelRelation['kind'],
  via: string,
  explicit = false
): ModelRelation => ({ from, to, kind, via, explicit })

/**
 * Extract the on-path corner points from an SVG smooth-step `d` string: the
 * `M`/`L` targets and each `Q` curve's end point (its final x y pair). Enough to
 * verify an edge's straight runs, ignoring the tiny rounded-corner arcs.
 */
function pathPoints(d: string): Pt[] {
  const tokens = d.split(/\s+/)
  const pts: Pt[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'M' || t === 'L') {
      pts.push({ x: Number(tokens[i + 1]), y: Number(tokens[i + 2]) })
      i += 2
    } else if (t === 'Q') {
      pts.push({ x: Number(tokens[i + 3]), y: Number(tokens[i + 4]) })
      i += 4
    }
  }
  return pts
}

/**
 * The `DealTag` ↔ `Tag` schema that motivated this module: `parseSchema` reports
 * the same logical link three ways — the `tag_id` fk column, the `tag` relation
 * it backs, and Tag's inverse `dealTags`.
 */
const dealTagRelations: ModelRelation[] = [
  rel('DealTag', 'Tag', 'fk', 'tag_id'),
  rel('DealTag', 'Tag', 'one', 'tag', true),
  rel('Tag', 'DealTag', 'many', 'dealTags', true)
]

describe('deriveRelationEdges', () => {
  it('collapses an fk + the relation it backs + the inverse into ONE edge', () => {
    const { pairs, selfs } = deriveRelationEdges(dealTagRelations)
    expect(selfs).toHaveLength(0)
    expect(pairs).toHaveLength(1)

    const edge = pairs[0]
    // Endpoints are stored in sorted order.
    expect(edge.a).toBe('DealTag')
    expect(edge.b).toBe('Tag')
    // Tag has many DealTag → crow at the DealTag end; DealTag has one Tag → bar at Tag.
    expect(edge.aMarker).toBe('many')
    expect(edge.bMarker).toBe('one')
    expect(edge.aVia).toBe('tag')
    expect(edge.bVia).toBe('dealTags')
    expect(edge.dashed).toBe(false)
    expect(edge.label).toBe('tag · dealTags')
  })

  it('keeps genuinely distinct links between the same pair (sender/recipient)', () => {
    const { pairs } = deriveRelationEdges([
      rel('Message', 'User', 'fk', 'sender_id'),
      rel('Message', 'User', 'fk', 'recipient_id')
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs.every((e) => e.dashed)).toBe(true)
    expect(pairs.map((e) => e.label).sort()).toEqual(['recipient_id', 'sender_id'])
    // Each is a to-one fk with no inverse → bar at the User end, nothing at Message.
    for (const e of pairs) {
      expect(e.a).toBe('Message')
      expect(e.b).toBe('User')
      expect(e.bMarker).toBe('one')
      expect(e.aMarker).toBe('none')
    }
  })

  it('does not drop an fk that no explicit relation backs', () => {
    // `backup_id` is NOT backed by the explicit `owner` relation.
    const { pairs } = deriveRelationEdges([
      rel('Doc', 'User', 'one', 'owner', true),
      rel('Doc', 'User', 'fk', 'owner_id'),
      rel('Doc', 'User', 'fk', 'backup_id')
    ])
    // owner_id is dropped (backs `owner`); owner + backup_id remain → 2 edges.
    expect(pairs).toHaveLength(2)
    const vias = pairs.map((e) => e.aVia).sort()
    expect(vias).toEqual(['backup_id', 'owner'])
  })

  it('models a one-to-many with the many end getting a crow', () => {
    const { pairs } = deriveRelationEdges([
      rel('Post', 'User', 'fk', 'user_id'),
      rel('User', 'Post', 'many', 'posts', true)
    ])
    expect(pairs).toHaveLength(1)
    const [e] = pairs
    expect(e.a).toBe('Post')
    expect(e.b).toBe('User')
    // User has many Post → crow at Post; Post has one User → bar at User.
    expect(e.aMarker).toBe('many')
    expect(e.bMarker).toBe('one')
    expect(e.dashed).toBe(false)
  })

  it('captures self-references separately', () => {
    const { pairs, selfs } = deriveRelationEdges([
      rel('Node', 'Node', 'one', 'parent', true),
      rel('Node', 'Node', 'many', 'children', true)
    ])
    expect(pairs).toHaveLength(0)
    expect(selfs).toHaveLength(2)
    expect(selfs.map((s) => s.via).sort()).toEqual(['children', 'parent'])
    expect(selfs.find((s) => s.via === 'children')?.many).toBe(true)
    expect(selfs.find((s) => s.via === 'parent')?.many).toBe(false)
  })

  it('is deterministic regardless of input order', () => {
    const a = deriveRelationEdges(dealTagRelations)
    const b = deriveRelationEdges([...dealTagRelations].reverse())
    expect(b).toEqual(a)
  })
})

// Two non-overlapping cards side by side, plus a helper to look them up.
const rects: Record<string, RectLike> = {
  DealTag: { left: 0, top: 0, width: 240, height: 200 },
  Tag: { left: 500, top: 0, width: 240, height: 200 },
  Message: { left: 0, top: 0, width: 240, height: 160 },
  User: { left: 600, top: 0, width: 240, height: 160 }
}
const rectOf = (name: string): RectLike | null => rects[name] ?? null

describe('computeEdgeGeometry', () => {
  it('draws exactly one line for the DealTag/Tag relationship', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    const rendered = computeEdgeGeometry(derived, rectOf)
    expect(rendered).toHaveLength(1)
    expect(rendered[0].d.startsWith('M ')).toBe(true)
  })

  it('routes orthogonally (rounded elbows, never a diagonal bezier)', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    // Different source/target rows force a real elbow (a level line needs none).
    const anchorY: AnchorFn = (entity) => (entity === 'DealTag' ? 40 : 120)
    const [edge] = computeEdgeGeometry(derived, rectOf, anchorY)
    // Smooth-step paths use quadratic corners (Q) and never cubic beziers (C):
    // this is the guard against regressing to the old free-floating curves that
    // looked "disconnected" on angled edges.
    expect(edge.d).toContain('Q')
    expect(edge.d).not.toContain('C')
  })

  it('caps each end with a single connector dot', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    const [edge] = computeEdgeGeometry(derived, rectOf)
    expect(edge.caps).toHaveLength(2)
    for (const c of edge.caps) {
      expect(typeof c.x).toBe('number')
      expect(typeof c.y).toBe('number')
    }
  })

  it('anchors each end to its field row and to the facing card side', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    // DealTag (left) exits its right edge; Tag (right) enters its left edge.
    const anchorY: AnchorFn = (entity) => (entity === 'DealTag' ? 40 : 70)
    const [edge] = computeEdgeGeometry(derived, rectOf, anchorY)
    const [src, tgt] = edge.caps
    expect(src.x).toBe(240) // DealTag.left(0) + width(240)
    expect(src.y).toBe(40)
    expect(tgt.x).toBe(500) // Tag.left(500)
    expect(tgt.y).toBe(70)
  })

  it('falls back to the card centre when a row cannot be measured', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    const [edge] = computeEdgeGeometry(derived, rectOf, () => null)
    // DealTag height 200 → centre y = 100.
    expect(edge.caps[0].y).toBe(100)
  })

  it('separates genuinely-parallel edges into distinct channels', () => {
    const derived = deriveRelationEdges([
      rel('Message', 'User', 'fk', 'sender_id'),
      rel('Message', 'User', 'fk', 'recipient_id')
    ])
    // Distinct field rows on the Message side, like the real DOM.
    const anchorY: AnchorFn = (entity, via) => {
      if (entity !== 'Message') return null
      return via === 'sender_id' ? 40 : 110
    }
    const rendered = computeEdgeGeometry(derived, rectOf, anchorY, { laneGap: 26 })
    expect(rendered).toHaveLength(2)
    // Their vertical channels must be pushed apart so the lines never overlap.
    expect(Math.abs(rendered[0].mx - rendered[1].mx)).toBeGreaterThanOrEqual(25)
    // ...and they attach to different source rows.
    expect(rendered[0].caps[0].y).not.toBe(rendered[1].caps[0].y)
  })

  it('skips edges whose endpoints have not been measured yet', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    const rendered = computeEdgeGeometry(derived, (name) =>
      name === 'Tag' ? null : rectOf(name)
    )
    expect(rendered).toHaveLength(0)
  })

  it('routes around a card that sits on the straight channel', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    // DealTag (left) ── Tag (right); a Blocker card straddles the mid channel.
    const local: Record<string, RectLike> = {
      DealTag: { left: 0, top: 0, width: 240, height: 200 },
      Tag: { left: 600, top: 0, width: 240, height: 200 }
    }
    const blocker: RectLike = { left: 360, top: 40, width: 120, height: 120 }
    const rectOfLocal = (name: string): RectLike | null => local[name] ?? null
    const obstacles = [local.DealTag, local.Tag, blocker]

    const [clear] = computeEdgeGeometry(derived, rectOfLocal, undefined)
    const [avoided] = computeEdgeGeometry(derived, rectOfLocal, undefined, { obstacles })

    // With no obstacle awareness the line cut straight through the blocker;
    // supplying the cards forces a different, detoured path.
    expect(avoided.d).not.toBe(clear.d)
    // Endpoints (connector dots) are unchanged — only the routing between moved.
    expect(avoided.caps).toEqual(clear.caps)
    // No axis-aligned run of the routed path crosses the raw blocker interior.
    const pts = pathPoints(avoided.d)
    for (let i = 1; i < pts.length; i++) {
      const seg = [pts[i - 1], pts[i]] as const
      const axisAligned = seg[0].x === seg[1].x || seg[0].y === seg[1].y
      if (axisAligned) expect(segmentHitsRect(seg[0], seg[1], blocker)).toBe(false)
    }
  })

  it('leaves a clear edge byte-identical when obstacles are supplied', () => {
    const derived = deriveRelationEdges(dealTagRelations)
    // DealTag and Tag are the only cards, so nothing blocks the channel.
    const obstacles = [rects.DealTag, rects.Tag]
    const [plain] = computeEdgeGeometry(derived, rectOf)
    const [withObstacles] = computeEdgeGeometry(derived, rectOf, undefined, { obstacles })
    expect(withObstacles.d).toBe(plain.d)
  })

  it('draws a self-relation as a dashed loop with two caps', () => {
    const derived = deriveRelationEdges([rel('Node', 'Node', 'many', 'children', true)])
    rects.Node = { left: 500, top: 400, width: 200, height: 120 }
    const [edge] = computeEdgeGeometry(derived, rectOf)
    expect(edge.self).toBe(true)
    expect(edge.dashed).toBe(true)
    expect(edge.caps).toHaveLength(2)
    expect(edge.d).toContain('Q')
  })

  it('produces stable geometry for a fixture (visual snapshot)', () => {
    const derived = deriveRelationEdges([
      ...dealTagRelations,
      rel('Node', 'Node', 'many', 'children', true)
    ])
    rects.Node = { left: 500, top: 400, width: 200, height: 120 }
    const rendered = computeEdgeGeometry(derived, rectOf).map((e) => ({
      id: e.id,
      d: e.d,
      caps: e.caps,
      label: e.label,
      dashed: e.dashed,
      self: e.self
    }))
    expect(rendered).toMatchSnapshot()
  })
})
