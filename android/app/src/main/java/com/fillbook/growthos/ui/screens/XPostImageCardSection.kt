package com.fillbook.growthos.ui.screens

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
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
private val INK = Color.parseColor("#F4F7FB")
private val MUTED = Color.parseColor("#9AA7BD")
private val CYAN = Color.parseColor("#3DD6F5")
private val AMBER = Color.parseColor("#F5B83D")

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

/** Draws the card to a bitmap. Pure drawing: text wraps and shrinks to fit, nothing is added or changed. */
fun renderXPostImageCard(card: XPostImageCard): Bitmap {
    val bmp = Bitmap.createBitmap(CARD_W, CARD_H, Bitmap.Config.ARGB_8888)
    val c = Canvas(bmp)
    c.drawColor(BG)
    val textW = (CARD_W - 2 * MARGIN_X).toInt()

    // Brand mark, top-left (inside the safe zone).
    c.drawCircle(MARGIN_X + 12f, 86f, 12f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = CYAN })
    c.drawText("Fillbook", MARGIN_X + 38f, 98f, paint(38f, INK, bold = true))

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
        // Headline card: shrink the headline until headline + figures fit the safe zone.
        val sizes = listOf(66f, 58f, 50f, 44f, 40f)
        var headline = layoutOf(card.title, paint(sizes.last(), INK, bold = true), textW)
        for (s in sizes) {
            val l = layoutOf(card.title, paint(s, INK, bold = true), textW, 5)
            val figures = if (card.numbers.isNotEmpty()) 36f + 104f else 0f
            headline = l
            if (l.height + figures <= SAFE_BOTTOM - SAFE_TOP) break
        }
        c.drawLayout(headline, MARGIN_X, SAFE_TOP)
        if (card.numbers.isNotEmpty()) {
            val figP = paint(96f, CYAN, bold = true)
            var x = MARGIN_X
            val y = SAFE_TOP + headline.height + 36f + 90f
            card.numbers.forEach { n ->
                c.drawText(n, x, y, figP)
                x += figP.measureText(n) + 56f
            }
        }
    }

    // Illustrative figures always carry the label (owner rule).
    if (card.sampleData) {
        c.drawText("SAMPLE DATA", MARGIN_X, CARD_H - 56f, paint(26f, AMBER, bold = true, spacing = 0.12f))
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
    val toX = Intent(send).setPackage("com.twitter.android").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
        context.startActivity(toX)
    } catch (e: android.content.ActivityNotFoundException) {
        context.startActivity(Intent.createChooser(send, "Post to X with the picture").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
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
