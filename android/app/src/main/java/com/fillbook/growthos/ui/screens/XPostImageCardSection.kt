package com.fillbook.growthos.ui.screens

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.provider.MediaStore
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import com.fillbook.growthos.data.XPostImageCard
import com.fillbook.growthos.ui.theme.TextTertiary
import java.io.File

/**
 * The picture for Today's X Post (owner direction 2026-11-08). The words and numbers come from the backend (xPostImageCard.ts: fixed
 * templates, figures copied verbatim from the post and checked there); this file only draws them, so nothing here decides what the card
 * says. The owner previews it, can discard it, and attaches it by hand: nothing is ever posted for him.
 */
private const val CARD_W = 1200
private const val CARD_H = 675 // 16:9, X's in-feed crop. Everything important stays inside the centre safe zone below.
private const val MARGIN_X = 110f
private const val SAFE_TOP = 150f
private const val SAFE_BOTTOM = 560f

private val BG = Color.parseColor("#0B1220")
private val PANEL = Color.parseColor("#141F30")
private val GRID = Color.parseColor("#1B2A3E")
private val INK = Color.parseColor("#F1F5F9")
private val MUTED = Color.parseColor("#94A3B8")
private val CYAN = Color.parseColor("#22D3EE")
private val AMBER = Color.parseColor("#FBBF24")
private val GREEN = Color.parseColor("#34D399")
private val COPPER = Color.parseColor("#C98A5A")
private val EVERGREEN = Color.parseColor("#2F8F6B")

private fun paint(size: Float, color: Int, bold: Boolean = false, spacing: Float = 0f) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = size
    this.color = color
    typeface = if (bold) Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD) else Typeface.SANS_SERIF
    letterSpacing = spacing
}

private fun layoutOf(text: String, p: TextPaint, width: Int, maxLines: Int = Int.MAX_VALUE): StaticLayout =
    StaticLayout.Builder.obtain(text, 0, text.length, p, width)
        .setAlignment(Layout.Alignment.ALIGN_NORMAL)
        .setLineSpacing(0f, 1.08f)
        .setMaxLines(maxLines)
        .setEllipsize(android.text.TextUtils.TruncateAt.END)
        .build()

private fun Canvas.drawLayout(l: StaticLayout, x: Float, y: Float) {
    save(); translate(x, y); l.draw(this); restore()
}


// ---- Theme "Risk Blueprint" (ChatGPT + Gemini, 2026-11-08): faint grid, brand mark, headline on the left 60%, a topic illustration on
// the right 40%, figures under the headline, a small seasonal accent. The illustration is built from simple shapes only: no words, no
// numbers, nothing that could state more than the post does. The seasonal accent is under 5% of the card and sits in a corner.

private fun stroke(color: Int, width: Float, round: Boolean = true) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    this.color = color
    style = Paint.Style.STROKE
    strokeWidth = width
    if (round) { strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
}

private fun fill(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; style = Paint.Style.FILL }

private fun Canvas.drawBlueprintBackdrop() {
    val p = stroke(GRID, 1.5f, round = false)
    var x = 0f
    while (x <= CARD_W) { drawLine(x, 0f, x, CARD_H.toFloat(), p); x += 60f }
    var y = 0f
    while (y <= CARD_H) { drawLine(0f, y, CARD_W.toFloat(), y, p); y += 60f }
}

/** The month's accent: Oct amber spark (Halloween), Nov copper leaf (Thanksgiving), Dec evergreen corner, Jan cyan arcs, Mar-Apr amber calendar grid. */
private fun Canvas.drawSeasonalAccent(month: Int) {
    val x0 = CARD_W - 150f
    val y0 = CARD_H - 135f
    when (month) {
        10 -> { // amber spark
            val p = stroke(AMBER, 5f)
            val cx = x0 + 60f; val cy = y0 + 55f
            drawLine(cx, cy - 36f, cx, cy + 36f, p); drawLine(cx - 36f, cy, cx + 36f, cy, p)
            drawLine(cx - 22f, cy - 22f, cx + 22f, cy + 22f, p); drawLine(cx - 22f, cy + 22f, cx + 22f, cy - 22f, p)
        }
        11 -> { // copper leaf outline
            val path = android.graphics.Path().apply {
                moveTo(x0 + 20f, y0 + 90f)
                quadTo(x0 + 10f, y0 + 20f, x0 + 90f, y0 + 10f)
                quadTo(x0 + 100f, y0 + 80f, x0 + 20f, y0 + 90f)
                close()
            }
            drawPath(path, stroke(COPPER, 5f))
            drawLine(x0 + 20f, y0 + 90f, x0 + 70f, y0 + 35f, stroke(COPPER, 4f))
        }
        12 -> { // restrained evergreen corner
            val p = stroke(EVERGREEN, 5f)
            drawLine(CARD_W - 40f, CARD_H - 120f, CARD_W - 40f, CARD_H - 40f, p)
            drawLine(CARD_W - 120f, CARD_H - 40f, CARD_W - 40f, CARD_H - 40f, p)
            drawLine(CARD_W - 40f, CARD_H - 120f, CARD_W - 100f, CARD_H - 60f, p)
        }
        1 -> { // thin cyan arcs
            val p = stroke(CYAN, 4f)
            drawArc(RectF(x0, y0, x0 + 110f, y0 + 110f), 180f, 90f, false, p)
            drawArc(RectF(x0 + 22f, y0 + 22f, x0 + 88f, y0 + 88f), 180f, 90f, false, p)
        }
        3, 4 -> { // understated amber calendar grid
            val p = stroke(AMBER, 3f)
            val gx = x0 + 20f; val gy = y0 + 20f
            drawRect(gx, gy, gx + 90f, gy + 78f, p)
            drawLine(gx, gy + 22f, gx + 90f, gy + 22f, p)
            drawLine(gx + 30f, gy + 22f, gx + 30f, gy + 78f, p); drawLine(gx + 60f, gy + 22f, gx + 60f, gy + 78f, p)
            drawLine(gx, gy + 50f, gx + 90f, gy + 50f, p)
        }
        else -> {}
    }
}

/** Draws the topic illustration into the box (left, top, width, height). Shapes only. */
private fun Canvas.drawMotif(motif: String?, left: Float, top: Float, w: Float, h: Float) {
    val panel = RectF(left, top, left + w, top + h)
    drawRoundRect(panel, 18f, 18f, fill(PANEL))
    drawRoundRect(panel, 18f, 18f, stroke(GRID, 3f))
    val pad = 34f
    val l = left + pad; val t = top + pad; val r = left + w - pad; val b = top + h - pad
    val iw = r - l; val ih = b - t
    when (motif) {
        "drawdown" -> { // a stepped, descending line that stops above a dashed floor
            val line = stroke(CYAN, 8f)
            val pts = floatArrayOf(l, t + ih * 0.12f, l + iw * 0.25f, t + ih * 0.12f, l + iw * 0.25f, t + ih * 0.35f, l + iw * 0.5f, t + ih * 0.35f,
                l + iw * 0.5f, t + ih * 0.55f, l + iw * 0.75f, t + ih * 0.55f, l + iw * 0.75f, t + ih * 0.68f, r, t + ih * 0.68f)
            val path = android.graphics.Path().apply {
                moveTo(pts[0], pts[1]); var i = 2
                while (i < pts.size) { lineTo(pts[i], pts[i + 1]); i += 2 }
            }
            drawPath(path, line)
            val dash = stroke(AMBER, 6f).apply { pathEffect = android.graphics.DashPathEffect(floatArrayOf(22f, 14f), 0f) }
            drawLine(l, b - ih * 0.06f, r, b - ih * 0.06f, dash)
        }
        "loss_limit" -> { // a semicircle gauge with a boundary marker
            val cx = (l + r) / 2f; val cy = b - ih * 0.12f; val rad = minOf(iw / 2f, ih * 0.8f)
            val oval = RectF(cx - rad, cy - rad, cx + rad, cy + rad)
            drawArc(oval, 180f, 180f, false, stroke(GRID, 22f, round = false).apply { color = Color.parseColor("#24364B") })
            drawArc(oval, 180f, 120f, false, stroke(CYAN, 22f, round = false))
            val ang = Math.toRadians(300.0)
            val mx = cx + (rad * Math.cos(ang)).toFloat(); val my = cy + (rad * Math.sin(ang)).toFloat()
            val mx2 = cx + ((rad - 44f) * Math.cos(ang)).toFloat(); val my2 = cy + ((rad - 44f) * Math.sin(ang)).toFloat()
            drawLine(mx, my, mx2, my2, stroke(AMBER, 9f))
        }
        "payout" -> { // stacked checklist panels with a threshold line
            val rowH = ih / 3.6f
            for (i in 0 until 3) {
                val ry = t + i * (rowH + ih * 0.06f)
                drawRoundRect(RectF(l, ry, r, ry + rowH), 10f, 10f, stroke(MUTED, 3f))
                drawRoundRect(RectF(l + 14f, ry + rowH * 0.28f, l + 14f + rowH * 0.44f, ry + rowH * 0.72f), 6f, 6f, if (i < 2) fill(GREEN) else stroke(MUTED, 3f))
                drawLine(l + 14f + rowH * 0.7f, ry + rowH / 2f, r - 20f, ry + rowH / 2f, stroke(MUTED, 5f))
            }
            val dash = stroke(AMBER, 5f).apply { pathEffect = android.graphics.DashPathEffect(floatArrayOf(16f, 12f), 0f) }
            drawLine(l, b, r, b, dash)
        }
        "consistency" -> { // near-equal bars, one slightly taller
            val n = 5; val gap = 16f; val bw = (iw - gap * (n - 1)) / n
            val heights = floatArrayOf(0.62f, 0.7f, 0.66f, 0.88f, 0.6f)
            for (i in 0 until n) {
                val bx = l + i * (bw + gap); val bh = ih * heights[i]
                drawRoundRect(RectF(bx, b - bh, bx + bw, b), 6f, 6f, fill(if (i == 3) AMBER else CYAN))
            }
            drawLine(l, b, r, b, stroke(MUTED, 4f))
        }
        "sizing" -> { // contract blocks growing in size
            val sizes = floatArrayOf(0.28f, 0.45f, 0.65f)
            var bx = l
            for (s in sizes) {
                val side = ih * s
                drawRoundRect(RectF(bx, b - side, bx + side, b), 8f, 8f, fill(CYAN))
                bx += side + 18f
            }
            drawLine(l, b, r, b, stroke(MUTED, 4f))
        }
        "edge_score" -> { // five connected nodes
            val cx = (l + r) / 2f; val cy = (t + b) / 2f; val rad = minOf(iw, ih) * 0.42f
            val pts = (0 until 5).map { i ->
                val a = Math.toRadians(-90.0 + i * 72.0)
                Pair(cx + (rad * Math.cos(a)).toFloat(), cy + (rad * Math.sin(a)).toFloat())
            }
            val edge = stroke(MUTED, 4f)
            for (i in pts.indices) { val a = pts[i]; val nb = pts[(i + 1) % 5]; drawLine(a.first, a.second, nb.first, nb.second, edge) }
            pts.forEachIndexed { i, p -> drawCircle(p.first, p.second, if (i == 0) 20f else 16f, fill(if (i == 0) AMBER else CYAN)) }
        }
        "journal" -> { // a timeline with entry markers
            val cy = (t + b) / 2f
            drawLine(l, cy, r, cy, stroke(MUTED, 5f))
            for (i in 0 until 5) {
                val mx = l + iw * (i / 4f)
                drawCircle(mx, cy, if (i == 3) 18f else 14f, fill(if (i == 3) AMBER else CYAN))
                drawLine(mx, cy - ih * 0.22f, mx, cy - 24f, stroke(MUTED, 4f))
            }
        }
        else -> { // target: concentric rings (also the fallback)
            val cx = (l + r) / 2f; val cy = (t + b) / 2f; val rad = minOf(iw, ih) * 0.46f
            drawCircle(cx, cy, rad, stroke(MUTED, 5f))
            drawCircle(cx, cy, rad * 0.66f, stroke(CYAN, 6f))
            drawCircle(cx, cy, rad * 0.32f, fill(AMBER))
        }
    }
}


/**
 * Card v2 (owner 2026-11-08, ChatGPT + Gemini agreed): the picture shows the mechanism the post only describes, and never repeats the
 * post's own first sentence. Words on it are a short verbatim line from the post plus a small fixed vocabulary (Intraday, End of day,
 * Peak, Floor); every figure is copied from the post with the words that precede it. A diagram of a rule, not an account's real result.
 */
/** The two figures of a trailing comparison, attached to the events they describe (rise to the peak, fall from it). */
private class TrailingFigures(val riseNote: String, val riseNumber: String, val fallNote: String, val fallNumber: String)

private fun Canvas.drawTrailingPanel(left: Float, top: Float, w: Float, h: Float, title: String, intraday: Boolean, figures: TrailingFigures?) {
    val panel = RectF(left, top, left + w, top + h)
    drawRoundRect(panel, 18f, 18f, fill(PANEL))
    drawRoundRect(panel, 18f, 18f, stroke(GRID, 3f))
    drawText(title, left + 28f, top + 58f, paint(44f, INK, bold = true))
    val l = left + 40f; val r = left + w - 40f; val t = top + 112f; val b = top + h - 40f
    val iw = r - l; val ih = b - t
    val xs = floatArrayOf(0f, 0.14f, 0.28f, 0.42f, 0.55f, 0.78f, 0.92f)
    val ys = floatArrayOf(0.80f, 0.64f, 0.70f, 0.40f, 0.12f, 0.30f, 0.40f)
    // The floor: moves up with every new high when intraday, stays put when end of day.
    val floorYs = if (intraday) floatArrayOf(0.96f, 0.96f, 0.96f, 0.88f, 0.74f, 0.74f, 0.74f) else floatArrayOf(0.96f, 0.96f, 0.96f, 0.96f, 0.96f, 0.96f, 0.96f)
    val floor = android.graphics.Path()
    for (i in xs.indices) { val px = l + iw * xs[i]; val py = t + ih * floorYs[i]; if (i == 0) floor.moveTo(px, py) else floor.lineTo(px, py) }
    drawPath(floor, stroke(AMBER, 8f).apply { pathEffect = android.graphics.DashPathEffect(floatArrayOf(26f, 15f), 0f) })
    val eq = android.graphics.Path()
    for (i in xs.indices) { val px = l + iw * xs[i]; val py = t + ih * ys[i]; if (i == 0) eq.moveTo(px, py) else eq.lineTo(px, py) }
    drawPath(eq, stroke(CYAN, 10f))
    val peakX = l + iw * xs[4]; val peakY = t + ih * ys[4]
    drawCircle(peakX, peakY, 14f, fill(CYAN))
    // "Peak" sits above its point, centred, clear of both lines.
    val peakP = paint(34f, INK, bold = true)
    drawText("Peak", peakX - peakP.measureText("Peak") / 2f, peakY - 26f, peakP)
    // "Floor" at the right end of its line: below it when the line is high, above it when the line is at the bottom.
    val floorP = paint(34f, AMBER, bold = true)
    val floorY = t + ih * floorYs[6]
    val floorLabelY = if (intraday) floorY + 40f else floorY - 18f
    drawText("Floor", r - floorP.measureText("Floor"), floorLabelY, floorP)
    // The post's own figures, attached to the events on the Intraday panel: the rise to the peak and the fall from it.
    if (figures != null && intraday) {
        val tick = stroke(MUTED, 4f)
        val bx = l + 6f
        val startY = t + ih * ys[0]
        drawLine(bx, peakY, bx, startY, tick)
        drawLine(bx, peakY, bx + 16f, peakY, tick)
        drawLine(bx, startY, bx + 16f, startY, tick)
        val noteP = paint(28f, MUTED)
        val numP = paint(40f, CYAN, bold = true)
        // Upper-left of the panel: the curve is low there, so the label clears it.
        drawText(figures.riseNote, bx + 24f, peakY + 28f, noteP)
        drawText(figures.riseNumber, bx + 24f, peakY + 70f, numP)
        val fx = r - 4f
        val endY = t + ih * ys[6]
        drawLine(fx, peakY, fx, endY, tick)
        drawLine(fx - 16f, peakY, fx, peakY, tick)
        drawLine(fx - 16f, endY, fx, endY, tick)
        val fallNumW = numP.measureText(figures.fallNumber)
        val fallNoteW = noteP.measureText(figures.fallNote)
        // Under the end of its bracket, right-aligned, in the open space between the curve and the floor.
        val lx = fx - maxOf(fallNumW, fallNoteW)
        drawText(figures.fallNote, lx, endY + 36f, noteP)
        drawText(figures.fallNumber, lx, endY + 78f, numP)
    }
}

/** Each figure with the words that precede it in the post (small, above the figure). Returns the bottom y. */
private fun Canvas.drawFigureChips(card: XPostImageCard, left: Float, baseline: Float, maxWidth: Float) {
    var size = 64f
    fun width(sz: Float): Double = card.numbers.mapIndexed { i, n ->
        maxOf(paint(sz, CYAN, bold = true).measureText(n), paint(sz * 0.42f, MUTED).measureText(card.figureNotes.getOrNull(i).orEmpty())).toDouble()
    }.sum() + 48.0 * (card.numbers.size - 1)
    while (size > 40f && width(size) > maxWidth) size -= 4f
    var x = left
    card.numbers.forEachIndexed { i, n ->
        val note = card.figureNotes.getOrNull(i).orEmpty()
        val figP = paint(size, CYAN, bold = true)
        val noteP = paint(size * 0.42f, MUTED)
        if (note.isNotBlank()) drawText(note, x, baseline - size - 6f, noteP)
        drawText(n, x, baseline, figP)
        x += maxOf(figP.measureText(n), noteP.measureText(note)) + 48f
    }
}

/** Draws the card to a bitmap. Pure drawing: text wraps and shrinks to fit, nothing is added or changed. */
fun renderXPostImageCard(card: XPostImageCard): Bitmap {
    val bmp = Bitmap.createBitmap(CARD_W, CARD_H, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    c.drawColor(BG)
    val textW = (CARD_W - 2 * MARGIN_X).toInt()

    // Brand mark, top-left (inside the safe zone).
    c.drawCircle(92f, 86f, 12f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = CYAN })
    c.drawText("Fillbook", 118f, 98f, paint(38f, INK, bold = true))

    if (card.kind == "reference") {
        val titleLayout = layoutOf(card.title, paint(58f, INK, bold = true), textW, 2)
        c.drawLayout(titleLayout, MARGIN_X, SAFE_TOP)
        var y = SAFE_TOP + titleLayout.height + 26f
        val dense = card.rows.size > 4
        val labelP = paint(if (dense) 34f else 40f, INK, bold = true)
        val noteP = paint(if (dense) 25f else 29f, MUTED)
        card.rows.forEach { row ->
            val label = layoutOf(row.label, labelP, textW, 1)
            c.drawLayout(label, MARGIN_X, y)
            y += label.height
            row.note?.let {
                val note = layoutOf(it, noteP, textW, 1)
                c.drawLayout(note, MARGIN_X, y + 2f)
                y += note.height + 2f
            }
            y += if (dense) 14f else 22f
        }
        card.footer?.let {
            c.drawLayout(layoutOf(it, paint(27f, CYAN), textW, 1), MARGIN_X, minOf(y + 8f, SAFE_BOTTOM + 10f))
        }
    } else {
        val line = card.hook ?: card.title
        if (card.compare) {
            // Two panels side by side: the same day, two kinds of floor.
            val lineLayout = layoutOf(line, paint(46f, INK, bold = true), 1040, 2)
            c.drawLayout(lineLayout, 80f, 132f)
            val panelTop = 132f + lineLayout.height + 22f
            // The two figures attach to the diagram when the post's own words say which is the rise and which is the fall ("Up", "Give back");
            // otherwise they sit under the panels with the words that precede them.
            val n0 = card.numbers.getOrNull(0); val n1 = card.numbers.getOrNull(1)
            val note0 = card.figureNotes.getOrNull(0).orEmpty(); val note1 = card.figureNotes.getOrNull(1).orEmpty()
            val attach = n0 != null && n1 != null &&
                Regex("(^|\\s)up$", RegexOption.IGNORE_CASE).containsMatchIn(note0.trim()) &&
                Regex("(give|gave|lose|lost|drop|back)", RegexOption.IGNORE_CASE).containsMatchIn(note1)
            val figures = if (attach) TrailingFigures(note0.trim(), n0!!, note1.trim(), n1!!) else null
            val figureRoom = if (card.numbers.isNotEmpty() && !attach) 110f else 0f
            val panelH = CARD_H - 34f - figureRoom - panelTop
            c.drawTrailingPanel(80f, panelTop, 500f, panelH, "Intraday", true, figures)
            c.drawTrailingPanel(620f, panelTop, 500f, panelH, "End of day", false, null)
            if (card.numbers.isNotEmpty() && !attach) c.drawFigureChips(card, 90f, CARD_H - 62f, 1020f)
        } else {
            // One big topic illustration on the right, the verbatim line and the labelled figures on the left.
            val leftW = 560
            val sizes = listOf(54f, 48f, 44f, 40f, 36f)
            var headline = layoutOf(line, paint(sizes.last(), INK, bold = true), leftW)
            for (sz in sizes) {
                val l = layoutOf(line, paint(sz, INK, bold = true), leftW, 6)
                headline = l
                if (l.height <= 300f) break
            }
            c.drawMotif(card.motif, 700f, 130f, 420f, 440f)
            c.drawLayout(headline, 80f, 150f)
            if (card.numbers.isNotEmpty()) c.drawFigureChips(card, 90f, CARD_H - 62f, 560f)
        }
    }


    // Illustrative figures always carry the label (owner rule).
    if (card.sampleData) {
        val sp = paint(26f, AMBER, bold = true, spacing = 0.12f)
        c.drawText("SAMPLE DATA", CARD_W - 80f - sp.measureText("SAMPLE DATA"), 98f, sp)
    }
    return bmp
}

private fun savePng(context: Context, bmp: Bitmap): android.net.Uri? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, "fillbook-x-post-${System.currentTimeMillis()}.png")
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Fillbook")
    }
    val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
    context.contentResolver.openOutputStream(uri)?.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) } ?: return null
    return uri
}

private fun sharePng(context: Context, bmp: Bitmap) {
    val dir = File(context.cacheDir, "x_cards").apply { mkdirs() }
    val file = File(dir, "fillbook-x-post.png")
    file.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, "Attach to your X post").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/**
 * Opens X's composer with the post text AND the picture attached (Android share: text + image to the X app, falling back to the chooser).
 * The text is also copied to the clipboard, so if X drops the text the owner can paste it. Nothing is posted: X opens a draft the owner sends.
 * The plain https://x.com/compose/post link cannot carry an image, which is why Copy + Open X alone never attached the picture.
 */
private fun openXWithPicture(context: Context, bmp: Bitmap, text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Today's X post", text))
    val dir = File(context.cacheDir, "x_cards").apply { mkdirs() }
    val file = File(dir, "fillbook-x-post.png")
    file.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        putExtra(Intent.EXTRA_TEXT, text)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    // Always through Android's chooser, never straight into the X app: a direct launch lets the phone remember a pick (X offers "Post" and
    // "Chat" as separate targets) and then reuse it every time. The chooser has no "always" option, so the owner picks Post each time.
    context.startActivity(Intent.createChooser(send, "Post to X with the picture").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/**
 * Preview of the post's picture with Open X with picture, Save, Share and Discard. [postText] is the text that goes with it; without it only
 * the picture actions show. The owner still presses Post in X.
 */
@Composable
internal fun XPostImageCardSection(card: XPostImageCard, assetKey: String?, postText: String? = null) {
    val context = LocalContext.current
    var discarded by rememberSaveable(assetKey) { mutableStateOf(false) }
    if (discarded) {
        Text("Image discarded for this post.", style = MaterialTheme.typography.bodySmall, color = TextTertiary)
        TextButton(onClick = { discarded = false }) { Text("Show image again") }
        return
    }
    val bitmap = remember(card) { renderXPostImageCard(card) }
    Spacer(Modifier.height(10.dp))
    Image(
        bitmap = bitmap.asImageBitmap(),
        contentDescription = "Picture for today's X post: ${card.title}",
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth().aspectRatio(CARD_W.toFloat() / CARD_H).clip(RoundedCornerShape(10.dp)),
    )
    Spacer(Modifier.height(4.dp))
    Column {
        Text(
            "Check it, then attach it to your post by hand.",
            style = MaterialTheme.typography.bodySmall,
            color = TextTertiary,
        )
        if (!postText.isNullOrBlank()) {
            androidx.compose.material3.Button(
                onClick = { openXWithPicture(context, bitmap, postText) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Open X with text + picture") }
            Text(
                "Opens X with your text and this picture attached. The text is also copied. You still press Post.",
                style = MaterialTheme.typography.bodySmall,
                color = TextTertiary,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            TextButton(onClick = { sharePng(context, bitmap) }) { Text("Share image") }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                TextButton(onClick = {
                    val ok = savePng(context, bitmap) != null
                    Toast.makeText(context, if (ok) "Saved to Pictures/Fillbook" else "Couldn't save the image", Toast.LENGTH_SHORT).show()
                }) { Text("Save") }
            }
            TextButton(onClick = { discarded = true }) { Text("Discard") }
        }
    }
}
