import { access, mkdir, writeFile, constants, readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { ChannelType } from "discord.js"
import type { Guild } from "discord.js"

export interface Category {
  id: string
  name: string
}

/**
 * Get category file
 * @param distCategoryFilePath
 */
export const getCategoryFile = async (
  distCategoryFilePath: string
): Promise<{
  categories: Category[]
  status: "success" | "failed"
  message?: any
}> => {
  try {
    await access(distCategoryFilePath, constants.R_OK)
    const categories = JSON.parse(
      await readFile(distCategoryFilePath, "utf8")
    ) as Category[]
    return { categories: categories, status: "success" }
  } catch (error) {
    return { categories: [], status: "failed", message: error }
  }
}

/**
 * Create category file
 * @param distCategoryFilePath
 * @param categories
 */
export const createCategoryFile = async (
  distCategoryFilePath: string,
  categories: Category[]
): Promise<{
  status: "success" | "failed"
  message?: any
}> => {
  try {
    await mkdir(dirname(distCategoryFilePath), {
      recursive: true,
    })
    await writeFile(distCategoryFilePath, JSON.stringify(categories, null, 2))
    return { status: "success" }
  } catch (error) {
    return { status: "failed", message: error }
  }
}

/**
 * Create category
 * @param discordGuild
 * @param categories
 * @param distCategoryFilePath
 */
export const createCategory = async (
  discordGuild: Guild,
  categories: Category[],
  distCategoryFilePath: string
): Promise<{
  categories: Category[]
  status: "success" | "failed"
  message?: any
}> => {
  try {
    // カテゴリーを作成する
    const newCategories: Category[] = []
    for (const category of categories) {
      const rusult = await discordGuild.channels.create({
        name: category.name,
        type: ChannelType.GuildCategory,
      })
      newCategories.push({
        id: rusult?.id ? rusult.id : "",
        name: category.name,
      })
    }

    // カテゴリーファイルを作成する
    const createCategoryFileResult = await createCategoryFile(
      distCategoryFilePath,
      categories
    )
    if (createCategoryFileResult.status === "failed") {
      return {
        categories: [],
        status: "failed",
        message: createCategoryFileResult.message,
      }
    }

    return { categories: newCategories, status: "success" }
  } catch (error) {
    return { categories: [], status: "failed", message: error }
  }
}

/**
 * Delete category
 * @param discordGuild
 * @param categories
 * @param distCategoryFilePath
 */
export const deleteCategory = async (
  discordGuild: Guild,
  categories: Category[],
  distCategoryFilePath: string
): Promise<{
  categories: Category[]
  status: "success" | "failed"
  message?: any
}> => {
  try {
    // カテゴリーを削除する
    const newCategories: Category[] = []
    for (const category of categories) {
      if (category.id) {
        await discordGuild.channels.delete(category.id)
        category.id = ""
      }
      newCategories.push(category)
    }

    // カテゴリーファイルを更新する
    const createCategoryFileResult = await createCategoryFile(
      distCategoryFilePath,
      newCategories
    )
    if (createCategoryFileResult.status === "failed") {
      return {
        categories: [],
        status: "failed",
        message: createCategoryFileResult.message,
      }
    }

    return { categories: newCategories, status: "success" }
  } catch (error) {
    return { categories: [], status: "failed", message: error }
  }
}
